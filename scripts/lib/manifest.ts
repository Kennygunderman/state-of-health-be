// The versioned manifest loader and repository-root path resolver for the
// meal-planning data files under `backend/data/meal-planning/`. Eight of the
// nine CLI entry points in `backend/scripts/` read their inputs through this
// module (`seed-dev.ts` is the exception), and it makes them three promises.
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
// THIRD, and for the same reason the first two exist at this boundary rather
// than in nine call sites: an artefact this module writes is PUBLISHED
// atomically, and a document written by several stages is merged without losing
// another stage's measurements. The files under `data/meal-planning/` are the
// pipeline's evidence — a reviewer reads them and `catalog-load.ts` checksums a
// release against its bytes — so a truncated file at a canonical path, a
// half-published report pair, or a stage's block silently replaced by the next
// stage's write are all failures of the same kind: evidence that looks
// authoritative and is wrong. See ARTEFACT PUBLICATION and CROSS-STAGE REPORT
// MERGING below for the mechanisms and why each is here.
//
// Scope (§1.1, §7.1): this module resolves paths, reads and writes JSON
// (including staging, locking and promoting the artefacts the stages publish),
// compares versions, and verifies the shape of the three policy documents whose
// missing fields would fail silently rather than loudly — the evidence
// allowlist, where an absent field removes a security limit; the USDA manifest,
// where an absent or mistyped field imports the wrong food under a name that
// looks right; and the coverage plan's model and prompt metadata, which is
// copied into a release manifest rather than computed with, so a wrong type
// there is shipped instead of raised. The other two documents it loads (the
// search benchmark and a generated release manifest) are version-checked and
// cast, because a missing field in either fails where it is used. Checksum
// verification belongs to `catalog-load.ts`, JSONL streaming to the release and
// load scripts, shortfall arithmetic to `catalog-report.ts`, the evidence
// policy's meaning to `src/services/evidence.logic.ts`, and model-call budgeting
// to `budget.ts`. It imports four Node built-ins (`crypto`, `fs`, `os`, `path`)
// and its sibling logger, reads no environment variable, and does nothing at
// import time — every read happens when a caller calls a loader, and every
// argument a rule depends on is a parameter, so the pure parts are
// unit-testable from `src/__tests__/scripts/` (§11: Jest's `roots` is
// `<rootDir>/src`, so no test file can live in this folder).

import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
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
    | 'invalid_manifest_shape'
    // The six publication codes (see ARTEFACT PUBLICATION). An operator acts
    // on each differently: `artifact_publication_locked` means another stage is
    // publishing into the same directory and this run should be repeated once it
    // finishes; `incomplete_staged_artifact` means a staged document was
    // truncated and the previous artefact was therefore kept;
    // `artifact_publication_failed` means a rename failed, and the message names
    // which artefacts were promoted and which kept their previous content; and
    // `invalid_merged_report` means a stage's report could not be represented as
    // JSON, so nothing was written at all.
    //
    // `unsafe_artifact_directory` is a refusal to write into, or read through, a
    // path that is not the plain thing it has to be: an output directory's
    // parent that is a symlink, that is not a directory at all, or that another
    // local principal may write to without the sticky bit; an output directory
    // whose name is already taken by an entry of any kind; or an artefact path
    // that is not a regular file. An operator answers it by pointing `--out`
    // (or `--out-dir`/`--out-path`) at a directory they own, typically one under
    // their home directory or the repository, rather than at a shared one.
    //
    // `untrusted_publication_journal` means a `.artefact-publication.journal`
    // was found that this module will not act on: it does not parse, it is not a
    // regular file, it is owned by another local principal or writable by one,
    // it is larger or carries more entries than a journal this pipeline writes
    // can, it names paths outside the directory being recovered, or it cannot
    // prove which generation an artefact held before the interrupted run.
    // Nothing is renamed or unlinked and the journal is KEPT, because acting on
    // it is the risk and deleting it would destroy the only record of the
    // interrupted publication. An operator answers it by reading the directory's
    // contents (the message names the journal and the exact reason), deciding
    // which generation each artefact should hold, and deleting the journal by
    // hand once they have.
    | 'artifact_publication_locked'
    | 'incomplete_staged_artifact'
    | 'artifact_publication_failed'
    | 'invalid_merged_report'
    | 'unsafe_artifact_directory'
    | 'untrusted_publication_journal';

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
// parents on the way. Root containment is the first of this module's three
// promises (see the header), so it is enforced here, at the single place every
// path is built, rather than left to nine CLI scripts to remember.
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

// ---------------------------------------------------------------------------
// ARTEFACT PUBLICATION — why every writer in this pipeline goes through here.
//
// The files under `data/meal-planning/reports/latest/` and
// `data/meal-planning/catalog/releases/` are the pipeline's EVIDENCE: a
// reviewer reads them to decide whether the catalog meets the requirement, and
// `catalog-load.ts` checksums a release against its own bytes. Writing one of
// them in place — `fs.writeFileSync(finalPath, …)` — makes two failures
// possible that no amount of care at the call site removes:
//
//   TRUNCATION. `writeFileSync` truncates the file before it writes, so an
//   interruption (a killed run, a full disk, an I/O error mid-write) leaves a
//   half-written document at the canonical path. The previous, complete
//   artefact is already gone, and what is left parses as nothing.
//
//   A HALF-PUBLISHED SET. `catalog-report.ts` writes TWO files whose quarantine
//   figures are reconciled against each other. Writing them one after the other
//   in place means a failure between the two leaves a mismatched pair — the one
//   outcome that file's header calls worse than no evidence at all, because it
//   is wrong and it looks authoritative.
//
// So publication here is: write a sibling temporary file in the SAME directory
// (a rename is only atomic within a filesystem), flush it to disk, check the
// document is complete, then `rename` it over the target — an atomic
// replacement on POSIX, so a reader sees either the previous artefact or the
// new one and never a partial document. A set of files is staged in full,
// checked, and then promoted back to back with nothing in between.
//
// The LOCK is the other half. Three stages (`catalog:import`,
// `catalog:generate`, `catalog:report`) merge into `import-report.json`, and a
// merge is a read-modify-write: two of them interleaved lose one stage's
// measurements even though each individual write is atomic. The advisory stage
// lock in `lib/checkpoint.ts` serialises the CATALOG GRAPH's mutators and
// cannot serve here — a dry run and the report stage take no graph lock by
// design, and both publish artefacts — so mutual exclusion over the artefact
// directory is its own, file-based lock.
//
// The lock file lives in the OS temporary directory, keyed by a hash of the
// directory it guards, NOT beside the artefacts: `reports/latest/` is committed
// to the repository, and a lock left behind by a killed run would show up as an
// untracked file in every `git status` after it. A stale lock is taken over
// rather than waited on (see ARTIFACT_LOCK_STALE_MS), because these are
// operator-run CLI stages: telling the operator which holder is publishing, or
// that a dead one was cleared, is more useful than blocking.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// FILESYSTEM SAFETY PRIMITIVES — why a publisher cannot simply open its output.
//
// Every publishing stage takes an output directory from a flag (`--out`,
// `--out-dir`, `--out-path`), and a flag accepts any directory: a shared one, a
// world-writable one, one whose parent another local principal can rename. Two
// classes of failure follow from that, and neither is visible in a run's output:
//
//   A FOLLOWED LINK. A create that follows a symlink another principal
//   pre-placed at the name this run is about to write truncates whatever the
//   link points at, with this process's privileges (CWE-59). A read that
//   follows one reads a document this pipeline never wrote and then checksums,
//   merges or accepts it as evidence.
//
//   A SPELLING MISTAKEN FOR AN IDENTITY. `path.resolve` collapses `..` but
//   leaves symlinks alone, so two spellings of one directory compare as two
//   directories — which is how two publishers each hold "their" lock over one
//   `import-report.json`, and how a path check against a canonical artefact
//   passes for an alias that writes straight into it.
//
// The primitives below are the answers, and they are exported and
// argument-driven so each rule is pinned by `src/__tests__/scripts/` rather
// than re-implemented per stage (Rule backend-architecture §1.2/§11). They
// create nothing unless their name says they do, and they refuse rather than
// repair: an output path a stage cannot prove is safe is an operator's flag to
// correct, not a directory for this module to fix up.
// ---------------------------------------------------------------------------

/**
 * The physical identity of `absolutePath`: every symlink on it resolved as far
 * as the path exists, with the not-yet-existing tail appended lexically.
 *
 * This is what "are these two paths the same place?" has to be asked of. A
 * spelling comparison answers "no" for an alias, which is the failure mode:
 * `--out /tmp/link-to-reports` and the committed
 * `data/meal-planning/reports/latest` name one directory and one artefact set.
 *
 * It CREATES NOTHING. A caller asking whether a path is safe to create must be
 * able to ask before creating it, and a primitive that made its argument exist
 * would answer a different question. `realpathSync` needs an existing path, so
 * the deepest existing ancestor is resolved and the components below it are
 * appended as they were spelled — those components do not exist, so no symlink
 * on them exists either, and the identity is exact as soon as they do.
 *
 * A resolution failure that is not "no such path" (a permission wall on an
 * ancestor) yields `path.resolve`'s answer and logs the reason, exactly as the
 * lock's directory identity has always done: a narrower identity still
 * distinguishes the ordinary case, and refusing to publish over an unresolvable
 * ancestor would be worse than a narrower guarantee.
 */
export const physicalPathIdentity = (absolutePath: string): string => {
    const resolved = path.resolve(absolutePath);
    let existing = resolved;
    // Innermost component first; reversed onto the resolved ancestor below.
    const missingTail: string[] = [];

    // Terminates at the filesystem root: every iteration either returns or
    // removes one component, and `path.dirname` of the root is the root, which
    // the equality check below treats as the end of the walk.
    for (;;) {
        try {
            const physicalAncestor = fs.realpathSync(existing);
            return missingTail.length === 0
                ? physicalAncestor
                : path.join(physicalAncestor, ...missingTail.reverse());
        } catch (error) {
            const code = (error as NodeJS.ErrnoException).code;
            const parent = path.dirname(existing);
            if (code === undefined || !MISSING_FILE_CODES.has(code) || parent === existing) {
                logger.warn('artifact_path_unresolved', {
                    path: describePath(resolved),
                    error: (error as Error).message,
                    consequence:
                        'The path is identified by its resolved spelling instead of its physical location, so a ' +
                        'caller reaching it through a symlink would not be recognised as reaching the same place.',
                });
                return resolved;
            }
            missingTail.push(path.basename(existing));
            existing = parent;
        }
    }
};

/**
 * Whether two paths name one physical place — the comparison every check
 * against a canonical artefact path has to make instead of `===` on strings.
 */
export const samePhysicalPath = (left: string, right: string): boolean =>
    physicalPathIdentity(left) === physicalPathIdentity(right);

// The write bits that say "someone other than the owner may create, rename or
// delete names in this directory": group-write and other-write.
const GROUP_OR_OTHER_WRITE_MODE = 0o022;

// The sticky bit. In a sticky directory only a name's owner (or the
// directory's) may rename or delete it, which is what makes `/tmp` usable at
// all.
const STICKY_MODE = 0o1000;

/**
 * Refuses `absolutePath` unless its PARENT is a directory this process can
 * publish into safely: it exists, it is a real directory under `lstat` rather
 * than a symlink to one, it is OWNED by the principal running this stage, and
 * no other local principal can plant a name in it.
 *
 * The parent rather than the path itself, because the attack is on the name
 * this run is about to create: a principal who can write to the parent can
 * pre-place that name as a symlink, and a create that follows it writes outside
 * the directory the operator named.
 *
 * Ownership is a requirement of its own rather than a consequence of the mode
 * rules. A `0700` or `0755` directory belonging to another local user satisfies
 * every mode rule below — no group or other write bit is set — and is still
 * unsafe: its owner can list the unguessable name this run creates inside it,
 * unlink it, put their own entry there, and widen the mode at any moment after
 * this check returns. An unguessable name defends against a principal who
 * cannot read the directory, which the owner of a directory always can.
 *
 * "No other principal can plant a name" is satisfied EITHER by no group or
 * other write bit, OR by the sticky bit. Sticky is sufficient rather than a
 * concession: a name another principal cannot guess cannot be pre-created (every
 * name this module creates under a shared directory carries
 * `unguessableSuffix`), and in a sticky directory they cannot rename or delete a
 * name they do not own either — which is exactly why the publication lock lives
 * in `os.tmpdir()`.
 *
 * Where POSIX owner and mode semantics are not available, the
 * existence-and-directory check still runs and the weaker guarantee is logged.
 * Windows reports synthesised mode bits that do not describe its ACLs and a uid
 * that describes nothing, so reading either there would produce a verdict about
 * nothing.
 */
export const assertSafeArtifactParent = (absolutePath: string): void => {
    const resolved = path.resolve(absolutePath);
    const parent = path.dirname(resolved);

    let parentStats: fs.Stats;
    try {
        // `lstat`, not `stat`: a symlinked parent is the case being refused, and
        // `stat` would report the directory it points at and pass.
        parentStats = fs.lstatSync(parent);
    } catch (error) {
        throw new ManifestError(
            'unsafe_artifact_directory',
            `${describePath(parent)} must exist before ${describePath(resolved)} can be published into it, and it ` +
                `could not be read: ${(error as Error).message}. Point the output flag at a directory you own.`,
        );
    }

    if (parentStats.isSymbolicLink()) {
        throw new ManifestError(
            'unsafe_artifact_directory',
            `${describePath(parent)} is a symbolic link, so what it points at can be changed underneath this run ` +
                'between the check and the write. Point the output flag at a real directory you own.',
        );
    }

    if (!parentStats.isDirectory()) {
        throw new ManifestError(
            'unsafe_artifact_directory',
            `${describePath(parent)} is not a directory, so ${describePath(resolved)} cannot be created inside it. ` +
                'Point the output flag at a directory you own.',
        );
    }

    if (process.platform === 'win32') {
        logger.warn('artifact_parent_permissions_unchecked', {
            directory: describePath(parent),
            reason: 'this platform reports synthesised POSIX mode bits that do not describe its access control',
            consequence:
                'The output directory was checked for existence and for being a real directory only; whether the ' +
                'principal running this stage owns it, and whether another local principal may plant a name in ' +
                'it, were not established.',
        });
        return;
    }

    // Ownership, before the mode rules, because a directory another user owns
    // is unsafe at ANY mode. A `0700` or `0755` directory belonging to another
    // local principal passes every check below — no group or other write bit is
    // set — while its owner can still list the staging nonce this run creates
    // inside it, unlink it and put their own entry at the name, and can change
    // the directory's mode at any moment after this check. The staging nonce is
    // unguessable to a principal who cannot READ the directory; the owner of a
    // directory always can.
    //
    // `process.getuid` is declared optional because it is POSIX-only, and the
    // win32 branch above has already returned by here, so reading it through
    // the optional call is a narrowing for the type system rather than a second
    // platform decision.
    const ourUid = process.getuid?.();
    if (ourUid !== undefined && parentStats.uid !== ourUid) {
        throw new ManifestError(
            'unsafe_artifact_directory',
            `${describePath(parent)} is owned by uid ${parentStats.uid} and this stage runs as uid ${ourUid}, so ` +
                'its owner can read, replace and remove the entries this publication creates inside it whatever ' +
                'its current mode is. Point the output flag at a directory you own.',
        );
    }

    const writableByOthers = (parentStats.mode & GROUP_OR_OTHER_WRITE_MODE) !== 0;
    const sticky = (parentStats.mode & STICKY_MODE) !== 0;
    if (writableByOthers && !sticky) {
        throw new ManifestError(
            'unsafe_artifact_directory',
            `${describePath(parent)} is writable by other local principals and is not sticky, so another user can ` +
                `pre-place or replace ${path.basename(resolved)} inside it between this check and the write. Point ` +
                'the output flag at a directory only you can write to, or set the sticky bit on this one.',
        );
    }
};

/**
 * Creates the directory at `absolutePath` and nothing else at that name.
 *
 * `mkdirSync(…, { recursive: true })` is the wrong primitive for the final
 * component: it treats an existing entry as success, so a symlink pre-placed at
 * the output directory's name is adopted and every artefact the run publishes
 * is written through it. A non-recursive `mkdir` is the atomic test-and-create
 * the kernel provides — an existing entry of ANY kind, symlink included, fails
 * with EEXIST — and this function turns that into a typed refusal.
 *
 * Parents are created recursively first (every publisher creates its output
 * tree anyway) and then held to `assertSafeArtifactParent`, so the name being
 * created is one no other principal can race. `mode` defaults to owner-only,
 * which keeps a freshly created output directory private to the operator who
 * ran the stage; the caller passes a wider mode only for a directory that is
 * meant to be shared.
 */
export const createExclusiveDirectory = (absolutePath: string, mode: number = 0o700): void => {
    const resolved = path.resolve(absolutePath);
    const parent = path.dirname(resolved);

    try {
        fs.mkdirSync(parent, { recursive: true });
    } catch (error) {
        throw new ManifestError(
            'unsafe_artifact_directory',
            `the parent directories of ${describePath(resolved)} could not be created: ${(error as Error).message}.`,
        );
    }

    assertSafeArtifactParent(resolved);

    try {
        fs.mkdirSync(resolved, { recursive: false, mode });
    } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        throw new ManifestError(
            'unsafe_artifact_directory',
            code === 'EEXIST'
                ? `${describePath(resolved)} already exists. This stage creates its own output directory so that an ` +
                  'entry pre-placed at that name — a symbolic link in particular — cannot redirect the artefacts it ' +
                  'publishes. Remove or rename what is there, or name a directory that does not exist yet.'
                : `${describePath(resolved)} could not be created: ${(error as Error).message}.`,
        );
    }

    // The created name is verified rather than assumed: `mkdir` succeeding is
    // proof enough on every platform this runs on, and the check costs one
    // `lstat` against the one state that would invalidate everything above it.
    const stats = fs.lstatSync(resolved);
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
        throw new ManifestError(
            'unsafe_artifact_directory',
            `${describePath(resolved)} is not a directory after being created, so the artefacts this stage publishes ` +
                'would be written somewhere other than where they were asked for.',
        );
    }
};

// Eight bytes: 16 hex characters, which is what every generated name in this
// module carries. Long enough that pre-placing a name is a guess against 2^64
// rather than a plan, and short enough to leave a basename readable in a
// directory listing an operator is reading to understand what a run left behind.
const UNGUESSABLE_SUFFIX_BYTES = 8;

/**
 * 16 lowercase hex characters from the CSPRNG — the component that makes a name
 * this module is about to create unguessable.
 *
 * Exclusive creation already refuses a name that is taken, so the suffix is the
 * second half of the same defence: an attacker who cannot guess the name cannot
 * pre-place it, and therefore never gets to race the create at all.
 */
export const unguessableSuffix = (): string => crypto.randomBytes(UNGUESSABLE_SUFFIX_BYTES).toString('hex');

// `O_NOFOLLOW` is POSIX and present on every platform this pipeline runs on,
// but it is not in Node's constants on every platform, and `undefined` in a
// bitwise OR becomes 0 silently — which would quietly remove the protection.
// Read once, explicitly, so the absence is a documented degradation rather than
// an invisible one.
const O_NOFOLLOW_FLAG = typeof fs.constants.O_NOFOLLOW === 'number' ? fs.constants.O_NOFOLLOW : 0;

/**
 * Creates and opens `absolutePath` for writing, refusing to follow a link or to
 * touch an existing entry. The caller closes the returned descriptor.
 *
 * `O_CREAT | O_EXCL` is the atomic "create this name or fail" the kernel
 * provides: a pre-placed entry of any kind, including a symlink, fails with
 * EEXIST instead of being written through. `O_NOFOLLOW` makes the refusal
 * explicit (ELOOP) where the platform defines it, which also covers the case of
 * a link appearing between a caller's own check and this call.
 *
 * The errno is deliberately left to propagate rather than being wrapped: EEXIST
 * is the outcome a staging writer retries with a new name, ELOOP is the one it
 * reports, and a typed error would erase that distinction. The file is created
 * owner-only, because a staged artefact is this run's private document until the
 * rename that publishes it.
 */
export const openArtifactForWriteSync = (absolutePath: string): number =>
    fs.openSync(absolutePath, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | O_NOFOLLOW_FLAG, 0o600);

/**
 * Reads `absolutePath` whole, refusing a symlink and anything that is not a
 * regular file.
 *
 * The reason this is not `fs.readFileSync`: a stage that reads an artefact back
 * — to checksum a release, to merge another stage's block into a report, to
 * compare a benchmark against the accepted one — makes a decision from what it
 * reads. `readFileSync` follows a symlink, so on a shared output directory that
 * decision can be made from a document this pipeline never wrote.
 *
 * `O_NOFOLLOW` refuses the link at the open where the platform defines it, and
 * `fstat` on the DESCRIPTOR — not a second `stat` on the path — is what rules
 * out a directory, a FIFO or a device without a window in which the path could
 * change between the two calls.
 */
export const readArtifactFileNoFollow = (absolutePath: string): Buffer => {
    const descriptor = fs.openSync(absolutePath, fs.constants.O_RDONLY | O_NOFOLLOW_FLAG);
    try {
        const stats = fs.fstatSync(descriptor);
        if (!stats.isFile()) {
            throw new ManifestError(
                'unsafe_artifact_directory',
                `${describePath(absolutePath)} is not a regular file, so it is not an artefact this pipeline wrote ` +
                    'and nothing was read from it.',
            );
        }

        const buffer = Buffer.alloc(stats.size);
        let filled = 0;
        // A single `readSync` is not required to return the whole file, so the
        // loop is the read: a short return is normal, and a zero return means
        // the file is shorter than its reported size (it was truncated while
        // being read), which the slice below reports honestly instead of
        // padding with zero bytes.
        while (filled < buffer.length) {
            const read = fs.readSync(descriptor, buffer, filled, buffer.length - filled, filled);
            if (read === 0) {
                break;
            }
            filled += read;
        }

        return filled === buffer.length ? buffer : buffer.subarray(0, filled);
    } finally {
        fs.closeSync(descriptor);
    }
};

/** The suffix every staged artefact carries while it is incomplete. */
const STAGING_SUFFIX = '.tmp';

/**
 * Removes a staging or lock file, treating "already gone" as success.
 *
 * A failure is warned about rather than thrown: every caller is either on the
 * failure path of a write that has already failed — where replacing the cause
 * with a cleanup error hides what the operator needs — or releasing a lock in a
 * `finally`, where throwing would mask the outcome of the publication itself.
 */
const removeIfPresent = (absolutePath: string): void => {
    try {
        fs.unlinkSync(absolutePath);
    } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== undefined && MISSING_FILE_CODES.has(code)) {
            return;
        }
        logger.warn('staged_artifact_not_removed', {
            file: describePath(absolutePath),
            error: (error as Error).message,
            remedy: 'Delete the leftover file by hand; no stage ever reads it.',
        });
    }
};

/**
 * A staged artefact: the complete document at `stagingPath`, and the canonical
 * path it becomes when the set it belongs to is promoted.
 */
export interface StagedArtifact {
    readonly finalPath: string;
    readonly stagingPath: string;
}

/**
 * The staging path for `absolutePath` — a hidden sibling in the same directory,
 * so the `rename` that promotes it stays within one filesystem.
 *
 * The process id and a counter are in the name because two publishers can be
 * staging the same artefact at the same moment (a killed run's leftover, an
 * operator running two stages); each writes its own file and only the promotion
 * touches the canonical path. Argument-driven and exported so the naming is
 * pinned by `src/__tests__/scripts/` (Rule backend-architecture §11).
 */
let stagingCounter = 0;
export const stagingPathFor = (absolutePath: string): string => {
    stagingCounter += 1;
    const directory = path.dirname(absolutePath);
    const name = path.basename(absolutePath);
    // The random component is what makes the name unguessable, and that matters
    // for more than collisions: `--out` accepts any directory, so on a shared
    // or world-writable one a predictable staging name can be pre-placed as a
    // symlink by another local principal, and a create that follows it would
    // truncate whatever it points at with this process's privileges (CWE-59).
    // Every creator of this path opens it `wx`/`'wx'`, which refuses an existing
    // entry of any kind including a symlink, so the guess would have to win a
    // race it cannot see; the random suffix removes the guess as well.
    //
    // The shape is not only a naming convention: the publication journal's
    // validator refuses an entry whose `stagingPath` is not a name this function
    // could have produced, so the format below and `STAGING_BASENAME_PATTERN`
    // are one contract and the suffix comes from one generator.
    return path.join(
        directory,
        `.${name}.${process.pid}.${stagingCounter}.${unguessableSuffix()}${STAGING_SUFFIX}`,
    );
};

/**
 * Flushes a directory entry so a promoted rename survives a power loss.
 *
 * Best effort by design: `fsync` on a directory descriptor is refused on some
 * platforms and filesystems (EPERM, EINVAL, EISDIR, ENOTSUP), and the rename
 * itself is already atomic with respect to any reader — the directory flush
 * only shortens the window in which a crash could lose it. Failing the
 * publication over a refused optimisation would turn a complete artefact into
 * a failed run.
 */
const IGNORED_DIRECTORY_FSYNC_CODES = new Set(['EPERM', 'EINVAL', 'EISDIR', 'ENOTSUP', 'EACCES', 'EBADF']);

const flushDirectory = (directory: string): void => {
    let descriptor: number | null = null;
    try {
        descriptor = fs.openSync(directory, 'r');
        fs.fsyncSync(descriptor);
    } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === undefined || !IGNORED_DIRECTORY_FSYNC_CODES.has(code)) {
            throw error;
        }
    } finally {
        if (descriptor !== null) {
            try {
                fs.closeSync(descriptor);
            } catch {
                // A close failure after a successful fsync has nothing left to
                // report: the data is already on disk and the descriptor dies
                // with the process.
            }
        }
    }
};

/**
 * Writes `text` to `absolutePath` atomically: a staged sibling, flushed to
 * disk, then renamed over the target.
 *
 * `wx` rather than `w` on the staging file, so a name collision is an error
 * rather than a silent overwrite of another publisher's staging document. The
 * staging file is removed if anything after its creation fails, so a failed
 * write leaves the previous artefact intact and no debris behind.
 *
 * `mode` is the permission the document must carry, and it is applied to the
 * STAGING FILE at creation rather than to the target afterwards: the staging
 * file holds the same bytes, so widening it first and narrowing the result
 * later would leave a window in which another principal could read or copy
 * them. The artefacts this pipeline publishes are evidence a reviewer reads, so
 * the default — `open`'s default mode, narrowed by the process umask — is
 * right for them; a caller passes a mode only for a document whose CONTENTS are
 * part of a security decision, which is the publication journal (see ARTEFACT
 * PUBLICATION). `fchmod` on the descriptor follows the create because `open`
 * masks its mode argument with the umask, so a requested `0600` under an
 * unusual umask would otherwise silently land without its owner-write bit.
 */
const writeFileAtomicSync = (absolutePath: string, text: string, mode?: number): void => {
    fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
    const stagingPath = stagingPathFor(absolutePath);

    let descriptor: number | null = null;
    try {
        descriptor = mode === undefined ? fs.openSync(stagingPath, 'wx') : fs.openSync(stagingPath, 'wx', mode);
        if (mode !== undefined) {
            fs.fchmodSync(descriptor, mode);
        }
        fs.writeFileSync(descriptor, text, 'utf8');
        fs.fsyncSync(descriptor);
    } catch (error) {
        if (descriptor !== null) {
            try {
                fs.closeSync(descriptor);
            } catch {
                // Reported through the original failure below.
            }
            descriptor = null;
        }
        removeIfPresent(stagingPath);
        throw error;
    }

    try {
        fs.closeSync(descriptor);
    } catch (error) {
        removeIfPresent(stagingPath);
        throw error;
    }

    try {
        fs.renameSync(stagingPath, absolutePath);
    } catch (error) {
        // The target still holds its previous content: `rename` either replaced
        // it or did nothing.
        removeIfPresent(stagingPath);
        throw error;
    }

    flushDirectory(path.dirname(absolutePath));
};

/**
 * Writes one JSON artefact to its canonical path, atomically.
 *
 * Every report and manifest writer in `scripts/` goes through this function
 * (`search-benchmark.ts`, `recipes-seed.ts`, `catalog-validate.ts`,
 * `catalog-report.ts` and `catalog-import-usda.ts` reach it directly or through
 * the staging helpers below), so the atomicity is a property of the pipeline
 * rather than of each call site.
 */
export const writeJsonFile = (absolutePath: string, value: unknown): void => {
    // `JSON.stringify` never ends with a line break, so appending one produces
    // exactly one — the POSIX convention every other tracked file here follows.
    writeFileAtomicSync(absolutePath, `${JSON.stringify(value, null, JSON_INDENT)}\n`);
};

/**
 * Stages one JSON artefact without publishing it: the complete document is
 * written and flushed to a sibling file, and `promoteStagedArtifacts` is what
 * makes it the artefact at `absolutePath`.
 *
 * Used when several artefacts must appear together — `catalog-report.ts`'s
 * reconciled report pair — or when a document has to be checked after it is
 * written and before it replaces the previous one.
 */
export const stageJsonArtifact = (absolutePath: string, value: unknown): StagedArtifact => {
    const staged: StagedArtifact = { finalPath: absolutePath, stagingPath: stagingPathFor(absolutePath) };
    fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
    writeFileAtomicSync(staged.stagingPath, `${JSON.stringify(value, null, JSON_INDENT)}\n`);
    return staged;
};

/**
 * The completeness check a staged document passes before it is promoted.
 *
 * It reads the file's SIZE and its LAST BYTES rather than parsing it: the
 * validation report is tens of megabytes, and parsing it to prove it parses
 * would cost a second and several hundred megabytes of heap on every run. What
 * a truncated document actually looks like is a file that stops mid-way, so a
 * document whose tail is the terminator its writer ends with is complete —
 * every JSON artefact here ends `}\n`.
 */
export const assertStagedDocumentComplete = (staged: StagedArtifact, expectedTail = '}\n'): void => {
    let size: number;
    try {
        size = fs.statSync(staged.stagingPath).size;
    } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== undefined && MISSING_FILE_CODES.has(code)) {
            throw new ManifestError(
                'incomplete_staged_artifact',
                `the staged document for ${describePath(staged.finalPath)} does not exist, so nothing was published.`,
            );
        }
        throw error;
    }

    const tail = Buffer.from(expectedTail, 'utf8');
    if (size < tail.length) {
        throw new ManifestError(
            'incomplete_staged_artifact',
            `the staged document for ${describePath(staged.finalPath)} is ${size} bytes, which is shorter than the ` +
                'terminator a complete document ends with, so it was not published and the previous artefact is intact.',
        );
    }

    const buffer = Buffer.alloc(tail.length);
    const descriptor = fs.openSync(staged.stagingPath, 'r');
    try {
        fs.readSync(descriptor, buffer, 0, tail.length, size - tail.length);
    } finally {
        fs.closeSync(descriptor);
    }

    if (!buffer.equals(tail)) {
        throw new ManifestError(
            'incomplete_staged_artifact',
            `the staged document for ${describePath(staged.finalPath)} does not end with the terminator a complete ` +
                'document ends with, so it was truncated; it was not published and the previous artefact is intact.',
        );
    }
};

// The journal that makes a multi-file publication a transaction. POSIX has no
// atomic rename of two paths, so promoting a reconciled pair with two renames
// leaves a window — and, if the second one fails or the process dies between
// them, leaves that mixed pair on disk permanently. The journal closes the
// permanent case: it is written and flushed BEFORE anything moves, it names
// every final path, its staged replacement and the backup its previous content
// was moved to, and its presence on disk means "a publication was interrupted
// here". `recoverInterruptedPublication` reverts such a set to its previous
// generation, and every publisher calls it before staging, so an interrupted
// publication is undone by the next run rather than inherited by it.
//
// One journal per directory, with a fixed name, is what makes it discoverable
// by a later process. Publishers are already serialised per directory by
// `withArtifactPublicationLock`, so two live journals in one directory cannot
// exist.
const PUBLICATION_JOURNAL_NAME = '.artefact-publication.journal';
const BACKUP_SUFFIX = '.previous';

/**
 * The version of the journal DOCUMENT, not of the module.
 *
 * Version 2 adds the two fields that make a journal something this module can
 * verify rather than something it has to trust: `directory`, the physical
 * identity of the directory the journal belongs to, and `finalExisted` per
 * entry, which is what lets a recovery prove the previous generation was
 * restored when that generation was "no artefact at all". A journal declaring a
 * HIGHER version was written by a build that knows fields this one would
 * silently ignore, so it is refused for the same reason a `v2` manifest is (see
 * the module header's SECOND promise); an absent version is a journal from
 * before the field existed and is accepted on its contents.
 */
const PUBLICATION_JOURNAL_VERSION = 2;

interface JournalEntry {
    readonly finalPath: string;
    readonly stagingPath: string;
    readonly backupPath: string;
    /**
     * Whether `finalPath` held an artefact when the publication began.
     *
     * Optional in the TYPE because a journal written before version 2 does not
     * carry it, and such a journal is still recoverable for every entry whose
     * backup is present — a backup is itself proof that a previous generation
     * existed. It is written unconditionally by this build.
     */
    readonly finalExisted?: boolean;
}

interface PublicationJournal {
    readonly journalVersion?: number;
    /** The physical identity (see {@link physicalPathIdentity}) of the directory this journal belongs to. */
    readonly directory?: string;
    readonly holderPid: number;
    readonly startedAt: string;
    readonly entries: readonly JournalEntry[];
}

const journalPathFor = (directory: string): string => path.join(directory, PUBLICATION_JOURNAL_NAME);

// ---------------------------------------------------------------------------
// WHY THE JOURNAL IS VALIDATED RATHER THAN READ.
//
// A journal tells a later process to `rename` one path over another and to
// `unlink` a third. Trusting the paths it names makes the document an
// instruction set: `--out` accepts any directory, so on a shared one another
// local principal writes `.artefact-publication.journal` naming
// `{finalPath: "~/.ssh/authorized_keys", backupPath: "<their file>"}`, and the
// next stage to publish there performs that rename with this process's
// privileges (CWE-22/CWE-59). No stage would notice: recovery is a routine
// step that logs a line.
//
// The journal is therefore BOUND to the directory being recovered and checked
// against the shapes this module itself generates, before anything moves:
//
//   Every path is a DIRECT CHILD of that directory. `path.dirname` equal to the
//   directory rules out traversal, an absolute path elsewhere, and a nested
//   subdirectory in one comparison, and it is the property that matters — a
//   principal who can write a journal into the directory can already write the
//   names inside it, so a journal that can only name those adds nothing to what
//   they have.
//
//   `finalPath` is a PLAIN ARTEFACT NAME (the module's own segment rule, which
//   refuses a leading dot), so a journal cannot make this module rename
//   something over another journal, a lock, a staging file or a backup.
//
//   `stagingPath` and `backupPath` match the patterns `stagingPathFor` and
//   `backupPathFor` GENERATE. Those names carry a CSPRNG suffix, so an entry
//   naming an arbitrary file in the directory is refused even though that file
//   is a direct child: the only paths a real journal names are ones this module
//   created.
//
// The rule set is pure and exported so it is pinned by unit tests rather than
// by a filesystem fixture (Rule backend-architecture §1.2/§11): every refusal
// branch is a security decision, and the ones that matter most are the ones a
// filesystem test is least likely to reach.
//
// CONFINEMENT IS NOT AUTHENTICATION, so the FILE is authenticated too. The
// rules above bound a journal to the names inside one directory, which answers
// the journal that points somewhere else — but not the confused deputy INSIDE
// the directory. In a world-writable sticky output directory another local user
// can create `.artefact-publication.journal` themselves, declare the right
// physical directory, invent staging and backup names of exactly the shapes
// above (nothing has to exist at them), and name a REAL artefact this pipeline
// owns with `finalExisted: false` and no backup. `planJournalSettlement` then
// plans `remove-new-final` and the recovery unlinks that artefact as its owner:
// sticky-bit rules stop the attacker deleting it themselves, and the recovery
// would have done it for them.
//
// `readJournal` therefore requires, on POSIX, that the journal be OWNED BY THE
// PRINCIPAL RUNNING THE STAGE and be writable by nobody else, and refuses
// anything else through `untrusted_publication_journal` — nothing renamed,
// nothing unlinked, the journal kept. Ownership is the instrument because the
// alternatives are not available here:
//
//   A TOKEN IS NOT A SECRET IN THIS DIRECTORY. A journal has to be readable by
//   the next run, and recovery happens in a LATER process holding a DIFFERENT
//   lock claim, so there is nothing for it to compare an embedded token against
//   — and a token embedded in a document the attacker can read would defend
//   against nobody. This build writes the journal `0600` for the same reason:
//   its contents name the paths a later run will act on, so no other principal
//   should be able to read them either, let alone copy them into a forgery.
//
//   A VERSION FIELD IS NOT PROVENANCE. Refusing a document that does not
//   declare `journalVersion` would refuse the legacy shape this module still
//   has to revert (see {@link PUBLICATION_JOURNAL_VERSION}), and an attacker
//   writes whatever version number the code demands anyway.
//
// The two caps below are the same decision applied to COST: a journal is read
// and parsed before any of the rules above can speak, so its size and its entry
// count are bounded first. A forged multi-gigabyte or millions-of-entries
// document would otherwise be allocated and parsed before being refused.
// ---------------------------------------------------------------------------

// A real journal is a few hundred bytes per artefact, and the largest set any
// stage in this pipeline publishes is a release's six members plus its
// manifest — two kilobytes of document. 1 MiB is therefore hundreds of times
// the real thing and still small enough to read and parse without thinking
// about it; a document past it did not come from this pipeline.
const MAX_PUBLICATION_JOURNAL_BYTES = 1024 * 1024;

// The same bound on the axis the byte cap does not constrain tightly: 1 MiB of
// minimal entries is tens of thousands of settlement decisions, each of which
// costs `lstat` calls and can rename or unlink a path. No publisher stages more
// than a handful of artefacts, so 64 is generous and still finite.
const MAX_PUBLICATION_JOURNAL_ENTRIES = 64;

// Owner-read/owner-write. The journal is the one document this module writes
// whose CONTENTS are an input to a later security decision, so another
// principal must not be able to read it and reproduce it (see above).
const PUBLICATION_JOURNAL_MODE = 0o600;

// The nonce width `unguessableSuffix` emits is 16 characters, and the bound is
// deliberately a RANGE rather than that exact number: a journal left by an
// earlier build (or by an operator reproducing one from the documentation) is a
// document this run may still have to revert, and the security property here is
// "a name this module generates in this directory", which the shape carries.
// Entropy is what `unguessableSuffix` guarantees for names being CREATED; it is
// not something a validator can verify after the fact.
const GENERATED_NONCE_PATTERN = '[0-9a-f]{8,32}';

// The characters a basename can legitimately contain that also mean something
// in a regular expression — `.` in every artefact name, and the rest defensively
// so a name can never be a pattern.
const escapeRegExpLiteral = (literal: string): string => literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The basenames `stagingPathFor` produces: `.<artefact>.<pid>.<counter>.<nonce>.tmp`. */
const stagingBasenamePattern = (artefactName: string): RegExp =>
    new RegExp(
        `^\\.${escapeRegExpLiteral(artefactName)}\\.[0-9]+\\.[0-9]+\\.${GENERATED_NONCE_PATTERN}${escapeRegExpLiteral(
            STAGING_SUFFIX,
        )}$`,
    );

/** The basenames `backupPathFor` produces: `.<artefact>.<pid>.<nonce>.previous`. */
const backupBasenamePattern = (artefactName: string): RegExp =>
    new RegExp(
        `^\\.${escapeRegExpLiteral(artefactName)}\\.[0-9]+\\.${GENERATED_NONCE_PATTERN}${escapeRegExpLiteral(
            BACKUP_SUFFIX,
        )}$`,
    );

/** A journal this module will act on, with the entries it may act on. */
export interface AcceptedPublicationJournal {
    readonly valid: true;
    readonly entries: readonly JournalEntry[];
}

/** A journal this module refuses, with the reason an operator is shown. */
export interface RefusedPublicationJournal {
    readonly valid: false;
    /** Names the entry index and the field that failed, so the refusal is actionable. */
    readonly reason: string;
}

export type PublicationJournalValidation = AcceptedPublicationJournal | RefusedPublicationJournal;

const refuse = (reason: string): RefusedPublicationJournal => ({ valid: false, reason });

/**
 * Decides whether a parsed `.artefact-publication.journal` document may be
 * acted on for `physicalDirectory`, and returns either its entries or the
 * reason it is refused.
 *
 * Pure: it performs no I/O and reads no clock, so every branch above is
 * exercised by a unit test rather than by arranging a filesystem. `parsed` is
 * `unknown` because the document is untrusted input — the whole point is that
 * its declared shape means nothing until this function has agreed with it.
 *
 * `physicalDirectory` is the identity of the directory being recovered (see
 * {@link physicalPathIdentity}), which the publication lock has already
 * resolved. Paths are compared after `path.resolve`, so a trailing separator or
 * a `.` component in either spelling is not a mismatch.
 */
export const validatePublicationJournal = (
    parsed: unknown,
    physicalDirectory: string,
): PublicationJournalValidation => {
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return refuse('the journal is not a JSON object');
    }

    const document = parsed as Record<string, unknown>;

    if (document.journalVersion !== undefined) {
        if (typeof document.journalVersion !== 'number' || !Number.isInteger(document.journalVersion)) {
            return refuse('"journalVersion" is present but is not an integer');
        }
        if (document.journalVersion > PUBLICATION_JOURNAL_VERSION) {
            return refuse(
                `"journalVersion" is ${document.journalVersion}, which is newer than the version this build ` +
                    `writes and reverts (${PUBLICATION_JOURNAL_VERSION})`,
            );
        }
    }

    const directory = path.resolve(physicalDirectory);

    if (document.directory !== undefined) {
        if (typeof document.directory !== 'string' || document.directory.length === 0) {
            return refuse('"directory" is present but is not a non-empty string');
        }
        if (path.resolve(document.directory) !== directory) {
            // A journal naming another directory did not come from a
            // publication into this one, whether it was copied here or written
            // here on purpose.
            return refuse(
                `"directory" names ${describeSegment(document.directory)}, which is not the directory being recovered`,
            );
        }
    }

    if (!Array.isArray(document.entries)) {
        return refuse('"entries" is not an array');
    }

    if (document.entries.length > MAX_PUBLICATION_JOURNAL_ENTRIES) {
        // Refused as a whole, before the loop below settles anything: each
        // entry costs `lstat` calls and can rename or unlink a path, and no
        // publisher in this pipeline stages this many artefacts.
        return refuse(
            `"entries" holds ${document.entries.length} entries, which is more than the ${MAX_PUBLICATION_JOURNAL_ENTRIES} ` +
                'a publication in this pipeline can leave behind',
        );
    }

    const entries: JournalEntry[] = [];

    for (let index = 0; index < document.entries.length; index += 1) {
        const candidate: unknown = document.entries[index];
        if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) {
            return refuse(`entry ${index} is not a JSON object`);
        }

        const entry = candidate as Record<string, unknown>;

        const paths: Record<string, string> = {};
        for (const field of ['finalPath', 'stagingPath', 'backupPath'] as const) {
            const value = entry[field];
            if (typeof value !== 'string' || value.length === 0) {
                return refuse(`entry ${index}'s "${field}" is not a non-empty string`);
            }
            const resolved = path.resolve(value);
            if (path.dirname(resolved) !== directory) {
                return refuse(
                    `entry ${index}'s "${field}" (${describeSegment(value)}) is not a direct child of the directory ` +
                        'being recovered',
                );
            }
            paths[field] = resolved;
        }

        const artefactName = path.basename(paths.finalPath);
        if (!SAFE_PATH_SEGMENT.test(artefactName)) {
            return refuse(
                `entry ${index}'s "finalPath" names ${describeSegment(artefactName)}, which is not a plain artefact ` +
                    'name',
            );
        }

        if (!stagingBasenamePattern(artefactName).test(path.basename(paths.stagingPath))) {
            return refuse(
                `entry ${index}'s "stagingPath" (${describeSegment(
                    path.basename(paths.stagingPath),
                )}) is not a staging name this module generates for ${artefactName}`,
            );
        }

        if (!backupBasenamePattern(artefactName).test(path.basename(paths.backupPath))) {
            return refuse(
                `entry ${index}'s "backupPath" (${describeSegment(
                    path.basename(paths.backupPath),
                )}) is not a backup name this module generates for ${artefactName}`,
            );
        }

        if (entry.finalExisted !== undefined && typeof entry.finalExisted !== 'boolean') {
            return refuse(`entry ${index}'s "finalExisted" is present but is not a boolean`);
        }

        entries.push({
            finalPath: paths.finalPath,
            stagingPath: paths.stagingPath,
            backupPath: paths.backupPath,
            ...(entry.finalExisted === undefined ? {} : { finalExisted: entry.finalExisted }),
        });
    }

    return { valid: true, entries };
};

/** The remedy every `untrusted_publication_journal` refusal ends with. */
const JOURNAL_REFUSAL_REMEDY =
    'Nothing was renamed or unlinked and the journal was kept, because acting on it is the risk and deleting it ' +
    'would destroy the only record of the interrupted publication. Inspect the directory\'s contents, decide which ' +
    'generation each artefact should hold, then delete the journal by hand.';

const untrustedJournal = (journalPath: string, reason: string): ManifestError =>
    new ManifestError(
        'untrusted_publication_journal',
        `${describePath(journalPath)} will not be acted on: ${reason}. ${JOURNAL_REFUSAL_REMEDY}`,
    );

// Same reasoning as `stagingPathFor`, and the same contract with the journal's
// validator (`BACKUP_BASENAME_PATTERN`): a backup is a name this module created
// in this directory, and an entry naming anything else is not a backup of ours
// to rename over a canonical artefact.
const backupPathFor = (absolutePath: string): string =>
    path.join(
        path.dirname(absolutePath),
        `.${path.basename(absolutePath)}.${process.pid}.${unguessableSuffix()}${BACKUP_SUFFIX}`,
    );

/**
 * Refuses a journal this process's principal does not own, or that another
 * principal may write to.
 *
 * `stats` comes from the DESCRIPTOR the bytes are read through, so what is
 * authenticated is the inode being read rather than a name that could have been
 * replaced since it was looked at. The two facts it carries are the whole
 * verdict: a journal owned by another uid was not written by this stage (nor by
 * any earlier run of it), and a journal any other principal can write to could
 * have been rewritten after a legitimate run created it. See the block above
 * ARTEFACT PUBLICATION's journal rules for why ownership, rather than a token or
 * a version field, is what can be checked here.
 *
 * Where POSIX identity is not available — `process.getuid` is absent on win32 —
 * the degradation is logged in the same shape `assertSafeArtifactParent` uses
 * and the read continues: the confinement rules still apply, and refusing every
 * recovery on a platform whose ACLs this module cannot read would leave an
 * interrupted publication permanently unrevertible.
 */
const assertJournalOwnedByThisPrincipal = (journalPath: string, stats: fs.Stats): void => {
    if (typeof process.getuid !== 'function') {
        logger.warn('publication_journal_ownership_unchecked', {
            journal: describePath(journalPath),
            reason: 'this platform does not report a POSIX owner, and its mode bits do not describe its access control',
            consequence:
                'The journal was checked for being a regular file and for naming only this directory\'s own ' +
                'generated paths; whether it was written by the principal running this stage, rather than by ' +
                'another local user choosing which artefacts this recovery renames and unlinks, was not established.',
        });
        return;
    }

    const ourUid = process.getuid();
    if (stats.uid !== ourUid) {
        throw untrustedJournal(
            journalPath,
            `it is owned by uid ${stats.uid} and this stage runs as uid ${ourUid}, so it was written by another ` +
                'local principal rather than by an interrupted publication of this pipeline — acting on it would ' +
                'rename and unlink the artefacts THEY chose, with this process\'s privileges',
        );
    }

    if ((stats.mode & GROUP_OR_OTHER_WRITE_MODE) !== 0) {
        throw untrustedJournal(
            journalPath,
            `its mode is ${(stats.mode & 0o7777).toString(8)}, which lets a principal other than its owner write ` +
                'to it, so its contents cannot be attributed to the publication that created it',
        );
    }
};

/**
 * Opens the journal, AUTHENTICATES the inode it opened, and reads it — one
 * descriptor for all three, so nothing about the file can change between the
 * verdict and the bytes.
 *
 * `O_NOFOLLOW` refuses a symlink at the open where the platform defines it, and
 * `fstat` on the descriptor — not a second `stat` on the path — is what rules
 * out a directory or a device, proves the ownership and mode, and bounds the
 * size BEFORE any of the document is read into memory or parsed.
 */
const readAuthenticatedJournal = (journalPath: string): Buffer => {
    const descriptor = fs.openSync(journalPath, fs.constants.O_RDONLY | O_NOFOLLOW_FLAG);
    try {
        const stats = fs.fstatSync(descriptor);
        if (!stats.isFile()) {
            throw untrustedJournal(
                journalPath,
                'it stopped being a regular file while it was being opened, so what it names is under the control ' +
                    'of whoever replaced it rather than of a publication that was interrupted here',
            );
        }

        assertJournalOwnedByThisPrincipal(journalPath, stats);

        if (stats.size > MAX_PUBLICATION_JOURNAL_BYTES) {
            throw untrustedJournal(
                journalPath,
                `it is ${stats.size} bytes, which is larger than the ${MAX_PUBLICATION_JOURNAL_BYTES} bytes a ` +
                    'journal this pipeline writes can reach, so it was not read into memory or parsed',
            );
        }

        // Reading by DESCRIPTOR rather than by path: the file authenticated
        // above is the file read here. The size is already bounded, and the one
        // principal who could grow it between the two calls is the owner the
        // check above has just established is us.
        return fs.readFileSync(descriptor);
    } finally {
        fs.closeSync(descriptor);
    }
};

/**
 * Reads the journal in a directory and returns the entries a recovery may act
 * on, or `null` when no publication was interrupted there.
 *
 * Every other outcome THROWS `untrusted_publication_journal`.
 *
 * The document is authenticated and bounded before it is parsed (see
 * {@link readAuthenticatedJournal}) and its contents are then held to
 * {@link validatePublicationJournal}. An UNPARSABLE journal is refused rather
 * than normalised to "no entries and clear it": that normalisation deleted the
 * only record of an interrupted publication and left whatever the killed run
 * had put at the canonical paths, reported as a successful recovery. A journal that does not parse is a directory an operator
 * has to look at, and this is the one moment the pipeline can tell them so.
 */
const readJournal = (journalPath: string, physicalDirectory: string): readonly JournalEntry[] | null => {
    let stats: fs.Stats;
    try {
        // `lstat`, not `stat`: a symlink at the journal name is the case being
        // refused, and `stat` would report whatever it points at.
        stats = fs.lstatSync(journalPath);
    } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== undefined && MISSING_FILE_CODES.has(code)) {
            return null;
        }
        throw error;
    }

    if (!stats.isFile()) {
        throw untrustedJournal(
            journalPath,
            'it is not a regular file, so what it names is under the control of whoever placed it there rather ' +
                'than of a publication that was interrupted here',
        );
    }

    let raw: Buffer;
    try {
        raw = readAuthenticatedJournal(journalPath);
    } catch (error) {
        // A refusal the reader already decided carries its own reason — the
        // ownership, mode and size verdicts among them — and is re-thrown as it
        // is rather than being flattened into one generic message.
        if (error instanceof ManifestError) {
            throw error;
        }
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== undefined && MISSING_FILE_CODES.has(code)) {
            // Removed between the `lstat` and the open, which only the holder of
            // this directory's lock can have done: its own recovery finished.
            return null;
        }
        if (code === 'ELOOP') {
            throw untrustedJournal(journalPath, 'it stopped being a regular file while it was being read');
        }
        throw error;
    }

    let parsed: unknown;
    try {
        parsed = JSON.parse(stripUtf8Bom(raw.toString('utf8')));
    } catch (error) {
        throw untrustedJournal(journalPath, `it does not parse as JSON (${(error as Error).message})`);
    }

    const validation = validatePublicationJournal(parsed, physicalDirectory);
    if (!validation.valid) {
        throw untrustedJournal(journalPath, validation.reason);
    }

    return validation.entries;
};

/**
 * What a recovery has to do to one journal entry to put the previous generation
 * back — decided for every entry BEFORE any of them is acted on.
 */
type JournalSettlement =
    /** A backup is present: renaming it back restores the previous generation. */
    | { readonly kind: 'restore-backup'; readonly entry: JournalEntry }
    /** No backup and the entry records that nothing was there: the previous generation is "no artefact". */
    | { readonly kind: 'remove-new-final'; readonly entry: JournalEntry; readonly finalPresent: boolean }
    /** No backup, an artefact existed and is still at its path: the backup loop never reached this entry. */
    | { readonly kind: 'previous-still-in-place'; readonly entry: JournalEntry };

const lstatOrNull = (absolutePath: string): fs.Stats | null => {
    try {
        return fs.lstatSync(absolutePath);
    } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== undefined && MISSING_FILE_CODES.has(code)) {
            return null;
        }
        throw error;
    }
};

/**
 * Settles every entry by PROOF, or refuses the whole journal.
 *
 * The four cases are exhaustive over what an interruption can leave, and each
 * one is decided by something observable rather than assumed:
 *
 *   A BACKUP IS PRESENT. Its existence is proof a previous generation was moved
 *   aside, whether or not the staged replacement made it in, so renaming it back
 *   restores that generation. It must be a REGULAR FILE: a symlink renamed onto
 *   the canonical path would make the artefact a symlink that every later reader
 *   follows, which is the same attack the staging paths are hardened against.
 *
 *   NO BACKUP, `finalExisted: false`. Nothing was at this path before the
 *   publication, so the previous generation is "no artefact" and restoring it
 *   means removing what this run put there. Without this case an interrupted
 *   ALL-NEW publication left its new documents at the canonical paths while the
 *   recovery reported a rollback.
 *
 *   NO BACKUP, `finalExisted: true`. The backup loop had not reached this entry,
 *   so the artefact at the path IS the previous generation and there is nothing
 *   to do. If it is absent, or is not a regular file, the previous generation
 *   cannot be shown to be in place — so the journal is kept and the refusal says
 *   which artefact.
 *
 *   NO BACKUP, NO RECORDED FLAG. "This run's new document" and "the generation
 *   published before it" are indistinguishable at that path — removing it could
 *   destroy the only artefact, and keeping it could publish a document no run
 *   agreed on. Only an operator can tell them apart, so the journal is kept.
 */
const planJournalSettlement = (
    entries: readonly JournalEntry[],
    journalPath: string,
): readonly JournalSettlement[] => {
    const plan: JournalSettlement[] = [];

    for (let index = 0; index < entries.length; index += 1) {
        const entry = entries[index];
        const artefact = path.basename(entry.finalPath);
        const backupStats = lstatOrNull(entry.backupPath);

        if (backupStats !== null) {
            if (!backupStats.isFile()) {
                throw untrustedJournal(
                    journalPath,
                    `entry ${index}'s backup of ${artefact} is not a regular file, so renaming it over the ` +
                        'canonical path would replace the artefact with something every later reader would follow',
                );
            }
            plan.push({ kind: 'restore-backup', entry });
            continue;
        }

        const finalStats = lstatOrNull(entry.finalPath);

        if (entry.finalExisted === false) {
            if (finalStats !== null && !finalStats.isFile()) {
                throw untrustedJournal(
                    journalPath,
                    `entry ${index} records that nothing was at ${artefact} before the interrupted publication, ` +
                        'but what is there now is not a regular file, so it is not this pipeline\'s document to remove',
                );
            }
            plan.push({ kind: 'remove-new-final', entry, finalPresent: finalStats !== null });
            continue;
        }

        if (entry.finalExisted === true) {
            if (finalStats === null) {
                throw untrustedJournal(
                    journalPath,
                    `entry ${index} records that ${artefact} existed before the interrupted publication, there is ` +
                        'no backup of it, and nothing is at its path, so the generation published before that run ' +
                        'cannot be shown to be restored',
                );
            }
            if (!finalStats.isFile()) {
                throw untrustedJournal(
                    journalPath,
                    `entry ${index} records that ${artefact} existed before the interrupted publication and what ` +
                        'is at its path now is not a regular file, so the previous generation cannot be shown to ' +
                        'be in place',
                );
            }
            plan.push({ kind: 'previous-still-in-place', entry });
            continue;
        }

        throw untrustedJournal(
            journalPath,
            `entry ${index} has no backup and does not record whether ${artefact} existed before the interrupted ` +
                'publication, so this run\'s new document and the generation published before it are ' +
                'indistinguishable at that path',
        );
    }

    return plan;
};

/**
 * Reverts an interrupted publication in `directory`, if one was left behind.
 *
 * Called by every publisher before it stages anything, and safe to call when
 * there is nothing to do. Reverting rather than completing is deliberate: a
 * crashed run's staged documents were never reconciled against each other by a
 * live process, so rolling forward could publish a pair no run ever agreed on,
 * while rolling back restores a generation that was published as a set.
 *
 * `physicalDirectory` is the identity the journal must be bound to, and it
 * defaults to the identity of `directory` so the one-argument call stays valid.
 * The under-lock caller passes the identity the LOCK keyed on, which is what
 * makes mutual exclusion and this recovery agree on which directory is being
 * recovered rather than each resolving the spelling for itself.
 *
 * Returns the final paths it reverted, so the caller can log that it happened —
 * an interrupted publication is an operational event, not a detail. A journal
 * this module will not act on throws `untrusted_publication_journal` with
 * nothing renamed or unlinked and the journal left in place.
 */
export const recoverInterruptedPublication = (
    directory: string,
    physicalDirectory: string = physicalPathIdentity(directory),
): readonly string[] => {
    const journalPath = journalPathFor(physicalDirectory);
    const entries = readJournal(journalPath, physicalDirectory);
    if (entries === null) {
        return [];
    }

    // Decided in full before anything moves, so every refusal above leaves the
    // directory exactly as it was found — including a refusal that only the
    // last entry earns.
    const plan = planJournalSettlement(entries, journalPath);

    const reverted: string[] = [];
    for (const settlement of plan) {
        const entry = settlement.entry;

        // Every failure below throws with the journal still in place: it is the
        // only record of which backup belongs to which artefact, and a revert
        // that could not finish is one the next run has to be able to retry.
        // "Already gone" is tolerated only where absence is the state being
        // produced — never for a backup that was supposed to be renamed back.
        if (settlement.kind === 'restore-backup') {
            try {
                fs.renameSync(entry.backupPath, entry.finalPath);
            } catch (error) {
                throw new ManifestError(
                    'artifact_publication_failed',
                    `restoring ${describePath(entry.finalPath)} from its backup failed ` +
                        `(${(error as Error).message}), so ${describePath(journalPath)} was kept and the next run ` +
                        'reverts the set from it.',
                );
            }
            reverted.push(describePath(entry.finalPath));
        } else if (settlement.kind === 'remove-new-final' && settlement.finalPresent) {
            try {
                // Not `removeIfPresent`: that warns and continues, and a new
                // artefact left at a canonical path is the failure this case
                // exists to prevent.
                fs.unlinkSync(entry.finalPath);
            } catch (error) {
                const code = (error as NodeJS.ErrnoException).code;
                if (code === undefined || !MISSING_FILE_CODES.has(code)) {
                    throw new ManifestError(
                        'artifact_publication_failed',
                        `removing the artefact the interrupted publication had created at ` +
                            `${describePath(entry.finalPath)} failed (${(error as Error).message}), so ` +
                            `${describePath(journalPath)} was kept and the next run reverts the set from it.`,
                    );
                }
            }
            reverted.push(describePath(entry.finalPath));
        }

        removeIfPresent(entry.stagingPath);
    }

    // The journal is the record of the interrupted publication, so it is
    // removed only once every entry has been settled — which is what makes its
    // absence mean "the previous generation is what is on disk".
    removeIfPresent(journalPath);
    flushDirectory(physicalDirectory);
    return reverted;
};

/**
 * Promotes a staged set to its canonical paths — the publication itself.
 *
 * This is the set's single commit point. The sequence is a write-ahead
 * transaction: verify every staged document, record the intent in a flushed
 * journal — including, per artefact, whether anything was at its canonical path
 * — move each previous artefact aside to a backup, rename the staged documents
 * in, then clear the journal and the backups.
 *
 * Any failure after the journal exists undoes BOTH halves of the generation it
 * found: an artefact that existed is restored from its backup, and an artefact
 * this run would have created is removed again. The second half is what makes
 * the guarantee true for an all-new or mixed set rather than only for a
 * replacement — so when this function returns, successfully or not, the
 * canonical paths hold either all of the new generation or all of the previous
 * one, and "previous" includes "there was nothing here". A process killed
 * mid-sequence leaves the journal, and the next publisher's
 * `recoverInterruptedPublication` reverts the set from it by the same rule.
 *
 * That rollback is PROVEN before it is reported. Every restoring `rename` and
 * every removal is tracked by its own outcome, and the journal and the backups
 * are destroyed only when all of them succeeded — a step that failed leaves its
 * backup and the journal on disk and is named in the thrown message, which then
 * says only that the set is not back. The two are not interchangeable: the
 * journal plus the backups are the entire means of recovering the previous
 * generation, so deleting them on an unproven rollback destroys it permanently.
 *
 * What this does NOT do, stated so no caller assumes it: a reader that does not
 * take the publication lock can still observe the instant between two renames.
 * Making that impossible would mean moving the artefacts behind a pointer the
 * readers follow, and their paths are fixed by the repository and referenced by
 * the docs and the tests. The guarantee here is over failures and crashes,
 * which is what leaves a mixed pair addressable afterwards.
 */
export const promoteStagedArtifacts = (staged: readonly StagedArtifact[]): void => {
    if (staged.length === 0) {
        return;
    }

    for (const artifact of staged) {
        assertStagedDocumentCompleteIfPresent(artifact);
    }

    const directories = new Set(staged.map((artifact) => path.dirname(artifact.finalPath)));
    if (directories.size > 1) {
        // The journal is per directory, so a set spanning two of them would need
        // two commit points and could not be one transaction. No caller does
        // this; refusing says so rather than silently degrading the guarantee.
        throw new ManifestError(
            'artifact_publication_failed',
            'an artefact set is published as one transaction through a journal in its own directory, so every ' +
                `artefact in the set must share one directory; this set spans ${directories.size}.`,
        );
    }
    // The journal and its entries are written in the directory's PHYSICAL
    // spelling, and the sequence below moves those same paths. The recovery that
    // may later read this journal resolves the identity the lock keyed on, so a
    // journal recorded in an aliased spelling would be refused as belonging to
    // another directory — and resolving once here also means a symlink
    // retargeted mid-sequence cannot redirect the remaining renames.
    const physicalDirectory = physicalPathIdentity([...directories][0]);
    const journalPath = journalPathFor(physicalDirectory);

    const entries: JournalEntry[] = staged.map((artifact) => {
        const finalPath = path.join(physicalDirectory, path.basename(artifact.finalPath));
        return {
            finalPath,
            stagingPath: path.join(physicalDirectory, path.basename(artifact.stagingPath)),
            backupPath: path.join(physicalDirectory, path.basename(backupPathFor(finalPath))),
            // Determined BEFORE the journal is written, because after the first
            // rename it is no longer observable: a recovery that cannot tell
            // "this run's new document" from "the generation published before
            // it" cannot prove it restored anything (see
            // `planJournalSettlement`).
            finalExisted: lstatOrNull(finalPath) !== null,
        };
    });

    // The journal is written and flushed first, so every state the sequence can
    // be interrupted in is one the recovery above can read and undo. Owner-only:
    // the next run authenticates this document by its ownership and mode, so a
    // world-readable journal would hand another principal the exact names a
    // forgery has to carry.
    writeFileAtomicSync(
        journalPath,
        `${JSON.stringify(
            {
                journalVersion: PUBLICATION_JOURNAL_VERSION,
                directory: physicalDirectory,
                holderPid: process.pid,
                startedAt: new Date().toISOString(),
                entries,
            } satisfies PublicationJournal,
            null,
            JSON_INDENT,
        )}\n`,
        PUBLICATION_JOURNAL_MODE,
    );

    const backedUp: JournalEntry[] = [];
    const promoted: JournalEntry[] = [];
    try {
        for (const entry of entries) {
            // The same predicate `finalExisted` was recorded with, so the
            // journal cannot say an artefact existed while this loop decides it
            // did not (an entry at the path that `existsSync` does not see — a
            // dangling symlink — used to make the two disagree).
            if (lstatOrNull(entry.finalPath) !== null) {
                fs.renameSync(entry.finalPath, entry.backupPath);
                backedUp.push(entry);
            }
        }
        for (const entry of entries) {
            fs.renameSync(entry.stagingPath, entry.finalPath);
            promoted.push(entry);
        }
    } catch (error) {
        // Roll the whole set back to the generation it had on entry. That
        // generation is "the previous document" for an artefact that existed and
        // "no artefact at all" for one this run would have created, and BOTH
        // halves have to be undone: restoring only the backups left this run's
        // new documents at the canonical paths of an all-new or mixed set while
        // the message below claimed the set was rolled back.
        //
        // Every step's OUTCOME is recorded, and the ones that did not happen are
        // named. Inferring the verdict from "is something at this path?" was
        // wrong in the one case that matters: if the restoring `rename` throws
        // while this run's newly promoted document is still sitting at the
        // canonical path, something IS there, so the existence predicate held,
        // the journal and every backup were deleted, and the previous generation
        // was gone for good behind a message claiming it had been restored.
        const restored: JournalEntry[] = [];
        const removed: JournalEntry[] = [];
        // What is still not the generation this run found, in the operator's
        // words. Its emptiness is the ONLY thing that authorises deleting the
        // journal or a backup below.
        const outstanding: string[] = [];

        for (const entry of backedUp) {
            try {
                // The rename SUCCEEDING is the proof, not something being at the
                // path afterwards: `rename` either moved the previous generation
                // back or it did not.
                fs.renameSync(entry.backupPath, entry.finalPath);
                restored.push(entry);
            } catch (restoreError) {
                outstanding.push(
                    `${describePath(entry.finalPath)} was not restored from ${describePath(entry.backupPath)} ` +
                        `(${(restoreError as Error).message})`,
                );
            }
        }

        const newlyPromoted = promoted.filter((entry) => entry.finalExisted === false);
        for (const entry of newlyPromoted) {
            try {
                // Regular files only: this run created what is at that path, and
                // anything else there is not this run's document to delete.
                if (lstatOrNull(entry.finalPath)?.isFile() === true) {
                    fs.unlinkSync(entry.finalPath);
                }
                if (lstatOrNull(entry.finalPath) === null) {
                    // Including the case where it was already gone: the previous
                    // generation of an artefact this run created is "no
                    // artefact", and that is what the path now holds.
                    removed.push(entry);
                } else {
                    outstanding.push(
                        `${describePath(entry.finalPath)} still holds an entry this run's publication created, ` +
                            'and it is not a regular file this pipeline may remove',
                    );
                }
            } catch (removeError) {
                outstanding.push(
                    `the document this run created at ${describePath(entry.finalPath)} was not removed ` +
                        `(${(removeError as Error).message})`,
                );
            }
        }

        discardStagedArtifacts(staged);
        const failed = entries
            .filter((entry) => !promoted.includes(entry))
            .map((entry) => describePath(entry.finalPath));

        if (outstanding.length === 0) {
            // Proven over both halves: every artefact that existed was renamed
            // back, and every artefact that did not exist is gone again. Only
            // now is "the artefacts hold the generation they had before this
            // run" true of the whole set, and only now may the record of the
            // interrupted publication and the backups it names be destroyed.
            removeIfPresent(journalPath);
            for (const entry of backedUp) {
                removeIfPresent(entry.backupPath);
            }
            flushDirectory(physicalDirectory);
            throw new ManifestError(
                'artifact_publication_failed',
                `publishing the artefact set failed at ${failed.join(', ')}, so the set was rolled back and every ` +
                    `artefact holds the generation it had before this run. ${(error as Error).message}`,
            );
        }

        // One outcome, stated once: the set is NOT back, these are the parts
        // that are not, and the journal and every backup it names are still on
        // disk for the next run's `recoverInterruptedPublication` to finish
        // from. Nothing here claims the generation was restored.
        flushDirectory(physicalDirectory);
        throw new ManifestError(
            'artifact_publication_failed',
            `publishing the artefact set failed at ${failed.join(', ')} and the rollback could not be completed: ` +
                `${outstanding.join('; ')}. ${restored.length + removed.length} of ${
                    backedUp.length + newlyPromoted.length
                } artefacts were put back; ${describePath(journalPath)} and the backups it names were KEPT, and the ` +
                `next run reverts the set from them. ${(error as Error).message}`,
        );
    }

    // Past this point the new generation is in place. Clearing the journal is
    // what ends the transaction; the backups are then dead weight.
    removeIfPresent(journalPath);
    for (const entry of backedUp) {
        removeIfPresent(entry.backupPath);
    }
    flushDirectory(physicalDirectory);
};

// A staged file already promoted by an earlier iteration is gone; the check is
// skipped for it rather than failing the publication it just completed.
const assertStagedDocumentCompleteIfPresent = (staged: StagedArtifact): void => {
    if (!fs.existsSync(staged.stagingPath)) {
        throw new ManifestError(
            'incomplete_staged_artifact',
            `the staged document for ${describePath(staged.finalPath)} does not exist, so nothing was published.`,
        );
    }
    assertStagedDocumentComplete(staged);
};

/**
 * Removes a staged set without publishing it — the failure path, and the reason
 * a failed run leaves neither debris nor a half-published pair.
 */
export const discardStagedArtifacts = (staged: readonly StagedArtifact[]): void => {
    for (const artifact of staged) {
        removeIfPresent(artifact.stagingPath);
    }
};

/**
 * How long a lock file may sit before a new publisher treats it as abandoned.
 *
 * Generous against the longest legitimate publication (the validation report is
 * tens of megabytes streamed row by row out of the database) and short enough
 * that a killed run does not block the next operator for an afternoon. A
 * holder whose process is gone is stale immediately, whatever its age.
 */
export const ARTIFACT_LOCK_STALE_MS = 30 * 60 * 1000;

/**
 * What identifies the HOLDER of a lock, as opposed to the lock file's name.
 *
 * `token` is CSPRNG hex minted per claim, and it is what makes two successive
 * claims by ONE process distinguishable: pid and `startedAt` can repeat — the
 * same publisher retaking the lock inside the same millisecond is the ordinary
 * case in a test and a plausible one in a fast retry — and "it looks like the
 * record I wrote" is then not the same statement as "it IS the record I wrote".
 *
 * An empty token means the record carries none: a lock file written by an
 * earlier build, or by hand. Such a record is still usable — identity falls
 * back to pid and `startedAt` — so a tokenless lock can still be released and
 * taken over rather than becoming permanently unclaimable.
 */
export interface ArtifactLockOwnership {
    readonly token: string;
    readonly pid: number;
    readonly startedAt: string;
}

interface ArtifactLockRecord extends ArtifactLockOwnership {
    readonly holder: string;
    readonly directory: string;
}

/**
 * A lock file as one observation: the inode it was, the bytes it had, and the
 * holder it named. Comparing two of these is how a decision taken about a lock
 * is checked against the lock still being the same one.
 *
 * `device` and `inode` change when the file is replaced (the claim path links a
 * fresh inode into place, so a release-and-retake always changes them), while
 * `modifiedAtMs` and `size` catch a rewrite in place that reused the inode.
 */
export interface ArtifactLockIdentity extends ArtifactLockOwnership {
    readonly device: number;
    readonly inode: number;
    readonly modifiedAtMs: number;
    readonly size: number;
}

/**
 * Whether two observations are of the SAME lock — every field, with a missing
 * observation never equal to anything, including another missing one.
 *
 * "The file is gone" is deliberately not an identity: a lock that vanished
 * between two reads was released, and the correct answer is to retry the claim
 * rather than to unlink a name that may already belong to someone else.
 *
 * Pure and exported because it is the whole of the stale-lock decision worth
 * pinning (Rule backend-architecture §1.2/§11): every field has to participate,
 * and a test is the only thing that keeps a later edit from dropping one.
 */
export const sameArtifactLock = (
    left: ArtifactLockIdentity | null,
    right: ArtifactLockIdentity | null,
): boolean =>
    left !== null &&
    right !== null &&
    left.device === right.device &&
    left.inode === right.inode &&
    left.modifiedAtMs === right.modifiedAtMs &&
    left.size === right.size &&
    left.token === right.token &&
    left.pid === right.pid &&
    left.startedAt === right.startedAt;

/**
 * Whether the lock record currently on disk is the one `ours` claimed.
 *
 * The token decides it whenever the CURRENT record carries one, because that is
 * the field a second claim cannot reproduce. A current record without a token
 * comes from an earlier build or from an operator's hand, and for those the
 * strongest available statement is pid plus start time — weaker, but it still
 * refuses to release a lock whose holder is a different process.
 */
export const artifactLockRecordIsOurs = (
    current: ArtifactLockOwnership,
    ours: ArtifactLockOwnership,
): boolean =>
    current.token.length > 0
        ? current.token === ours.token
        : current.pid === ours.pid && current.startedAt === ours.startedAt;

export interface ArtifactPublicationLock {
    readonly lockPath: string;
    /**
     * The physical directory this lock was keyed on — the identity, not the
     * spelling the caller passed (see {@link physicalPathIdentity}).
     *
     * Published because mutual exclusion and path safety have to agree on which
     * directory is being published into: a holder that resolved its output
     * directory once, took the lock on that identity, and then wrote through the
     * original spelling would have serialised one place and written to another.
     * Every write a holder performs is meant to be relative to this value, and
     * `recoverInterruptedPublication` takes it as the identity a journal must be
     * bound to.
     */
    readonly physicalDirectory: string;
    readonly release: () => void;
}

/**
 * The physical identity of an artefact directory — what the lock is keyed on.
 *
 * `path.resolve` is not enough: it collapses `..` and makes the path absolute
 * but leaves symlinks alone, so `--out /tmp/link-to-reports` and the committed
 * `data/meal-planning/reports/latest` resolve to different strings while naming
 * the same directory and the same `import-report.json`. Keying the lock on the
 * spelling would let two publishers each hold "their" lock and overwrite each
 * other's merged fields. {@link physicalPathIdentity} collapses the aliases to
 * one identity, and logs its own reason when an ancestor cannot be resolved.
 *
 * The directory is created here, which is the one thing the exported primitive
 * deliberately does not do: a lock is taken by a publisher that is about to
 * write into this directory, so it exists either way, and the identity is exact
 * rather than part-lexical once it does.
 */
const physicalDirectoryIdentity = (directory: string): string => {
    try {
        fs.mkdirSync(directory, { recursive: true });
    } catch (error) {
        logger.warn('artifact_lock_directory_unresolved', {
            directory: describePath(directory),
            error: (error as Error).message,
            consequence:
                'The publication lock is keyed on whatever identity the path resolves to without the directory ' +
                'being created, so a publisher reaching this directory through a symlink may not contend for the ' +
                'same lock.',
        });
    }

    return physicalPathIdentity(directory);
};

const artifactLockPathFor = (physicalIdentity: string): string =>
    path.join(
        os.tmpdir(),
        `soh-artifact-publication-${crypto
            .createHash('sha256')
            .update(physicalIdentity)
            .digest('hex')
            .slice(0, 16)}.lock`,
    );

const readArtifactLockRecord = (lockPath: string): ArtifactLockRecord | null => {
    let raw: string;
    try {
        raw = fs.readFileSync(lockPath, 'utf8');
    } catch {
        return null;
    }
    try {
        const parsed: unknown = JSON.parse(raw);
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
            return null;
        }
        const record = parsed as Partial<ArtifactLockRecord>;
        if (typeof record.pid !== 'number' || typeof record.startedAt !== 'string') {
            return null;
        }
        return {
            holder: typeof record.holder === 'string' ? record.holder : 'unknown',
            pid: record.pid,
            startedAt: record.startedAt,
            directory: typeof record.directory === 'string' ? record.directory : '',
            // Absent rather than invalid: a record written before the token
            // existed is still a record, and `artifactLockRecordIsOurs` falls
            // back to pid and start time for it.
            token: typeof record.token === 'string' ? record.token : '',
        };
    } catch {
        // A lock file that does not parse carries no holder to name, so it is
        // treated as abandoned rather than as a reason to stop publishing.
        return null;
    }
};

/**
 * One observation of the lock file: its record (when it has a readable one) and
 * its inode identity, read back to back.
 *
 * Both halves come from one call so a caller cannot accidentally pair a record
 * read at one moment with a `stat` taken at another — which is precisely the
 * mistake the stale-lock recheck exists to avoid.
 */
const observeArtifactLock = (
    lockPath: string,
): { readonly record: ArtifactLockRecord | null; readonly identity: ArtifactLockIdentity | null } => {
    const record = readArtifactLockRecord(lockPath);

    let stats: fs.Stats;
    try {
        stats = fs.lstatSync(lockPath);
    } catch {
        // Gone, or unreadable: either way there is no identity to hold a later
        // decision to.
        return { record, identity: null };
    }

    return {
        record,
        identity: {
            device: stats.dev,
            inode: stats.ino,
            modifiedAtMs: stats.mtimeMs,
            size: stats.size,
            token: record?.token ?? '',
            pid: record?.pid ?? 0,
            startedAt: record?.startedAt ?? '',
        },
    };
};

const holderProcessIsAlive = (pid: number): boolean => {
    if (!Number.isInteger(pid) || pid <= 0) {
        return false;
    }
    if (pid === process.pid) {
        return true;
    }
    try {
        // Signal 0 checks for the process without touching it.
        process.kill(pid, 0);
        return true;
    } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        // EPERM means the process exists and belongs to someone else.
        return code === 'EPERM';
    }
};

/**
 * How long an unreadable lock record is assumed to belong to a live holder
 * still writing it, rather than to a dead one.
 *
 * A lock whose record cannot be parsed used to be treated as abandoned outright,
 * which is unsafe for the one case that matters: a holder that has just created
 * the file. Claiming is atomic-with-content now (see below), so this window only
 * has to cover a record written by an older build or truncated by a crash mid
 * write — and for those, waiting a minute and reporting the lock is strictly
 * better than two publishers believing they own it.
 */
const ARTIFACT_LOCK_RECORD_SETTLING_MS = 60 * 1000;

const artifactLockIsStale = (record: ArtifactLockRecord | null, now: number, lockPath: string): boolean => {
    if (record === null) {
        // No readable record. Fail towards "held" while the file is fresh: an
        // unreadable record is indistinguishable from one being written, and
        // stealing it is the failure mode that lets two publishers run.
        let modifiedAt: number;
        try {
            modifiedAt = fs.statSync(lockPath).mtimeMs;
        } catch {
            // The file vanished between the read and the stat, so whoever held
            // it released it.
            return true;
        }
        return now - modifiedAt > ARTIFACT_LOCK_RECORD_SETTLING_MS;
    }
    if (!holderProcessIsAlive(record.pid)) {
        return true;
    }
    const startedAt = Date.parse(record.startedAt);
    return !Number.isFinite(startedAt) || now - startedAt > ARTIFACT_LOCK_STALE_MS;
};

/**
 * Claims `lockPath` exclusively, with its record already in it.
 *
 * `open(wx)` cannot do this: it creates an empty file and the record lands in a
 * second call, so a contender reading in between sees no record and — under any
 * rule that treats an unreadable record as abandoned — steals a live lock. The
 * record is therefore written to a private temporary file first and `link`ed
 * into place: `link` fails with EEXIST if the name is taken, so the claim is
 * atomic, and the file is never observable without its content.
 *
 * Returns false when the name is already taken; throws for any other failure.
 */
const claimArtifactLockFile = (lockPath: string, payload: string): boolean => {
    const pending = `${lockPath}.${process.pid}.${crypto.randomBytes(8).toString('hex')}${STAGING_SUFFIX}`;
    let descriptor: number | null = null;
    try {
        descriptor = fs.openSync(pending, 'wx');
        fs.writeFileSync(descriptor, payload, 'utf8');
        fs.fsyncSync(descriptor);
    } catch (error) {
        if (descriptor !== null) {
            try {
                fs.closeSync(descriptor);
            } catch {
                // Reported through the original failure.
            }
        }
        removeIfPresent(pending);
        throw error;
    }
    fs.closeSync(descriptor);

    try {
        fs.linkSync(pending, lockPath);
        return true;
    } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'EEXIST') {
            return false;
        }
        throw error;
    } finally {
        // The temporary name is always dropped: on success the lock path is a
        // second link to the same inode, which is what the holder releases.
        removeIfPresent(pending);
    }
};

const LOCK_ACQUIRE_ATTEMPTS = 3;

/**
 * Takes the publication lock for one artefact directory, or throws
 * `ManifestError('artifact_publication_locked')` naming the holder.
 *
 * Exported with its own release so a caller that publishes across an await
 * boundary can hold it for the whole sequence; prefer the two wrappers below,
 * which cannot forget to release it.
 */
export const acquireArtifactPublicationLock = (directory: string, holder: string): ArtifactPublicationLock => {
    const physicalIdentity = physicalDirectoryIdentity(directory);
    const lockPath = artifactLockPathFor(physicalIdentity);
    const record: ArtifactLockRecord = {
        holder,
        pid: process.pid,
        startedAt: new Date().toISOString(),
        directory: physicalIdentity,
        // Minted per claim, so this holder's lock is distinguishable from the
        // lock the same process claims a moment later (see
        // `ArtifactLockOwnership`).
        token: unguessableSuffix(),
    };
    const payload = `${JSON.stringify(record, null, JSON_INDENT)}\n`;

    for (let attempt = 1; attempt <= LOCK_ACQUIRE_ATTEMPTS; attempt += 1) {
        if (!claimArtifactLockFile(lockPath, payload)) {
            // The record and the inode identity of the file the verdict below
            // is about, read as one observation.
            const observed = observeArtifactLock(lockPath);
            const existing = observed.record;
            if (!artifactLockIsStale(existing, Date.now(), lockPath)) {
                throw new ManifestError(
                    'artifact_publication_locked',
                    `${describePath(directory)} is being published by ${existing?.holder ?? 'another stage'} ` +
                        `(pid ${existing?.pid ?? 0}, since ${existing?.startedAt ?? 'an unknown time'}), so this run ` +
                        'stopped rather than interleaving two writes into the same evidence artefacts. Wait for that ' +
                        'stage to finish, or clear the lock once you have confirmed it is gone.',
                );
            }

            // The verdict was taken about the file as it was observed above, and
            // reaching it took a `process.kill` probe and a timestamp parse. A
            // lock released and freshly claimed in that window is a DIFFERENT
            // lock, and unlinking it by pathname deleted a live holder's claim
            // and let two publishers into one directory (CWE-367). Re-read
            // immediately before the unlink and act only while the two
            // observations are the same lock.
            const beforeUnlink = observeArtifactLock(lockPath);
            if (!sameArtifactLock(observed.identity, beforeUnlink.identity)) {
                logger.warn('artifact_publication_lock_changed_hands', {
                    directory: describePath(directory),
                    previousHolder: existing?.holder ?? 'unparsable lock file',
                    currentHolder: beforeUnlink.record?.holder ?? 'unparsable or absent lock file',
                    reason:
                        'the lock was released and re-claimed between the staleness verdict and the takeover, so ' +
                        'the new claim was left in place',
                    outcome: 'this run retries the claim instead of clearing a lock that is no longer stale',
                });
                continue;
            }

            logger.warn('artifact_publication_lock_taken_over', {
                directory: describePath(directory),
                previousHolder: existing?.holder ?? 'unparsable lock file',
                previousPid: existing?.pid ?? 0,
                previousStartedAt: existing?.startedAt ?? 'unknown',
                reason: 'the recorded holder is gone or older than the stale bound, so its lock was cleared',
            });
            // THE RESIDUAL RACE, STATED RATHER THAN IMPLIED. The recheck cannot
            // be fused with the unlink: Node exposes no unlink-by-handle or
            // unlink-by-inode primitive, so a lock that changes hands in the
            // instant between the recheck and this call is still deleted. The
            // window is now the two statements below rather than a `kill` probe,
            // a `stat`, a timestamp parse and a log line, and what it costs is
            // bounded by what the lock protects: a publication whose lock was
            // broken still writes each artefact atomically and still promotes
            // through the journal, so the loss is a merged report's block, not a
            // truncated artefact. Closing it completely needs a lock manager
            // outside the filesystem, which these operator-run CLI stages do
            // not have.
            removeIfPresent(lockPath);
            continue;
        }

        return {
            lockPath,
            physicalDirectory: physicalIdentity,
            release: (): void => {
                // Only OUR record is removed: a lock another publisher took
                // over after ours went stale belongs to that publisher, and
                // deleting it would hand the directory to a third writer. The
                // token is what answers "ours" when the same process is the one
                // that retook it.
                const current = readArtifactLockRecord(lockPath);
                if (current !== null && !artifactLockRecordIsOurs(current, record)) {
                    logger.warn('artifact_publication_lock_not_ours', {
                        directory: describePath(directory),
                        holder: current.holder,
                        pid: current.pid,
                        reason: 'the lock was taken over while this stage held it, so it was left in place',
                    });
                    return;
                }
                removeIfPresent(lockPath);
            },
        };
    }

    throw new ManifestError(
        'artifact_publication_locked',
        `${describePath(directory)} could not be locked for publication after ${LOCK_ACQUIRE_ATTEMPTS} attempts: ` +
            'another publisher is clearing and retaking the lock. Run the stage again once no other stage is running.',
    );
};

/** Synchronous publication under the directory lock, released on every path. */
export const withArtifactPublicationLockSync = <T>(directory: string, holder: string, publish: () => T): T => {
    const lock = acquireArtifactPublicationLock(directory, holder);
    try {
        revertInterruptedPublicationUnderLock(directory, lock.physicalDirectory, holder);
        return publish();
    } finally {
        lock.release();
    }
};

/** Asynchronous publication under the directory lock, released on every path. */
export const withArtifactPublicationLock = async <T>(
    directory: string,
    holder: string,
    publish: () => Promise<T>,
): Promise<T> => {
    const lock = acquireArtifactPublicationLock(directory, holder);
    try {
        revertInterruptedPublicationUnderLock(directory, lock.physicalDirectory, holder);
        return await publish();
    } finally {
        lock.release();
    }
};

/**
 * Reverts a publication a previous process was killed in the middle of.
 *
 * Runs inside the lock, before the new publication stages anything, so it is
 * serialised against every other publisher and cannot race the run it is
 * cleaning up after. Placed here rather than in the four call sites for the
 * same reason the marker clearing lives in the merge: a producer that forgets
 * it would silently inherit a half-published set, and there is no signal that
 * would tell it to.
 *
 * `physicalDirectory` is passed rather than re-derived: the journal is bound to
 * the directory's identity, and the authority for that identity is the one the
 * LOCK keyed on. Resolving it twice would let the two disagree — which is the
 * whole failure mode of comparing spellings instead of identities.
 */
const revertInterruptedPublicationUnderLock = (
    directory: string,
    physicalDirectory: string,
    holder: string,
): void => {
    const reverted = recoverInterruptedPublication(directory, physicalDirectory);
    if (reverted.length > 0) {
        logger.warn('interrupted_publication_reverted', {
            directory: describePath(directory),
            holder,
            reverted: reverted.join(', '),
            reason:
                'a previous publication was interrupted after it began promoting, so the artefacts it had already ' +
                'replaced were restored from their backups. The set is the generation published before that run.',
            remedy: 'Re-run the stage that was interrupted; nothing from the interrupted run was kept.',
        });
    }
};

// ---------------------------------------------------------------------------
// CROSS-STAGE REPORT MERGING — one document, three stages, no lost block.
//
// `import-report.json` is written by `catalog:import`, `catalog:generate` and
// `catalog:report`, and each of them owns part of it. Two kinds of key live in
// that document and they merge differently:
//
//   STAGE-PRIVATE keys — `counts`, `aiGenerationCounts`, `usdaRequests`,
//   `modelSpend`, `categories` — belong to one stage, which replaces its own
//   and never touches another's.
//
//   SHARED COMPOUND blocks — `duplicatesRemoved` and `failuresByCheck` — are
//   co-written: each stage contributes its own SUB-KEYS (`…AtImport`,
//   `importStage`, `generationStage`, `measuredFromCatalog`) to one block,
//   because the three measurements answer the same question from three
//   vantage points and a reader wants them side by side.
//
// A top-level spread (`{...existing, ...written}`) is correct for the first
// kind and silently destructive for the second: it replaces the whole block,
// so an import erased generation's `generationStage` sub-key and a generation
// run erased the import's. `mergeStageReport` is the one place that knows the
// difference, and `MERGED_REPORT_COMPOUND_BLOCKS` is the reviewed list — adding
// a fourth shared block is a change to that constant, not to three call sites.
// ---------------------------------------------------------------------------

export const MERGED_REPORT_COMPOUND_BLOCKS: readonly string[] = ['duplicatesRemoved', 'failuresByCheck'];

// Keys that mark an artefact as NOT the output of these producers. A committed
// report that predates a producer carries one so a reader cannot mistake it for
// evidence of the reviewed implementation; it names what is absent and the
// command that regenerates the artefact.
export const PROVISIONAL_REPORT_MARKER_KEYS: readonly string[] = ['staleness'];

// The field inside the marker that makes freshness a PER-STAGE obligation
// rather than one flag. This distinction is the whole point: these artefacts
// are co-written by several stages, each owning different sections, so "is this
// artefact current?" has one answer per stage and not one answer overall. A
// marker cleared by whichever stage happened to write last would let a
// generation-only run — which measures no import telemetry, no resume
// aggregation and no final aggregates — declare the sections it never touched
// current again, which is the same untruth the marker exists to prevent.
//
// So the marker lists the stages whose sections are stale, each measured write
// removes only its OWN stage from that list, and the marker disappears only
// when the list empties. A stage absent from the list discharges nothing: it
// has no outstanding obligation to discharge, and it must not clear anyone
// else's.
export const FRESHNESS_OBLIGATIONS_FIELD = 'outstandingStages';

export interface StageReportMergePolicy {
    /** The key under which the merge records what it preserved. */
    readonly noteKey: string;
    /** The stage's own name, as the note states it. */
    readonly stage: string;
    /** Top-level keys whose sub-keys belong to several stages. */
    readonly compoundBlocks?: readonly string[];
}

export interface StageReportMerge {
    readonly document: Record<string, unknown>;
    /** Top-level keys this write left exactly as it found them. */
    readonly preservedKeys: readonly string[];
    /** Sub-keys another stage owns that survived inside a shared block. */
    readonly preservedSubKeys: Readonly<Record<string, readonly string[]>>;
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
    value !== null && typeof value === 'object' && !Array.isArray(value);

/**
 * Merges one stage's report into the document already on disk.
 *
 * Key POSITION is preserved as well as key value: the existing document is
 * spread first, so a rerun of one stage produces a diff of the fields that
 * changed rather than a reordering of the whole artefact.
 *
 * The merged document is serialised here, before any caller writes it, so a
 * value that cannot be represented as JSON (a cycle, a BigInt) fails as a
 * merge error naming the report rather than halfway through a write that has
 * already truncated the previous artefact.
 */
export const mergeStageReport = (
    existing: Readonly<Record<string, unknown>> | null,
    written: Readonly<Record<string, unknown>>,
    policy: StageReportMergePolicy,
): StageReportMerge => {
    const compound = new Set(policy.compoundBlocks ?? MERGED_REPORT_COMPOUND_BLOCKS);
    const base = existing ?? {};
    const document: Record<string, unknown> = { ...base };
    const preservedSubKeys: Record<string, readonly string[]> = {};

    for (const key of Object.keys(written)) {
        const incoming = written[key];
        const current = base[key];

        if (compound.has(key) && isPlainObject(current) && isPlainObject(incoming)) {
            const carried = Object.keys(current).filter(
                (subKey) => !Object.prototype.hasOwnProperty.call(incoming, subKey),
            );
            if (carried.length > 0) {
                preservedSubKeys[key] = carried.sort();
            }
            document[key] = { ...current, ...incoming };
            continue;
        }

        document[key] = incoming;
    }

    // Discharge this stage's own freshness obligation, and only its own. See
    // FRESHNESS_OBLIGATIONS_FIELD for why this is per stage: a measured write is
    // evidence for the sections THIS stage owns and says nothing about the
    // others', so it may cross itself off the marker's list and no one else.
    // The marker is removed only when the list empties, i.e. when every stage
    // that owes this artefact a measurement has delivered one.
    const clearedProvisionalMarkers: string[] = [];
    let dischargedFreshnessObligation: string | null = null;
    let outstandingFreshnessObligations: readonly string[] | null = null;

    for (const key of PROVISIONAL_REPORT_MARKER_KEYS) {
        if (
            !Object.prototype.hasOwnProperty.call(base, key) ||
            Object.prototype.hasOwnProperty.call(written, key)
        ) {
            continue;
        }

        const marker = base[key];
        if (!isPlainObject(marker)) {
            // Not an object, so it carries no obligation list; left alone for
            // the same conservative reason as a malformed list below.
            outstandingFreshnessObligations = null;
            continue;
        }
        const obligations = marker[FRESHNESS_OBLIGATIONS_FIELD];
        if (!Array.isArray(obligations) || obligations.some((entry) => typeof entry !== 'string')) {
            // A marker with no usable obligation list cannot say whose sections
            // are stale, so this write leaves it alone. Failing towards "still
            // stale" is the conservative direction: the alternative is clearing
            // a warning about sections this stage never measured.
            outstandingFreshnessObligations = null;
            continue;
        }

        const remaining = (obligations as readonly string[]).filter((entry) => entry !== policy.stage);
        if (remaining.length === obligations.length) {
            // This stage owes this artefact nothing, so it discharges nothing —
            // and, critically, clears nothing.
            outstandingFreshnessObligations = remaining;
            continue;
        }

        dischargedFreshnessObligation = policy.stage;
        if (remaining.length === 0) {
            delete document[key];
            clearedProvisionalMarkers.push(key);
            outstandingFreshnessObligations = remaining;
        } else {
            document[key] = { ...marker, [FRESHNESS_OBLIGATIONS_FIELD]: remaining };
            outstandingFreshnessObligations = remaining;
        }
    }
    clearedProvisionalMarkers.sort();

    // The note key is excluded because it is THIS write's own bookkeeping: a
    // previous run of the same stage left it behind, and listing it as a key
    // preserved from another stage would be a false statement in the artefact.
    // Another stage's note key is not excluded — that one really is a field
    // this write left alone. Cleared provisional markers are excluded too: they
    // were removed, not carried forward.
    const preservedKeys = Object.keys(base)
        .filter(
            (key) =>
                key !== policy.noteKey &&
                !clearedProvisionalMarkers.includes(key) &&
                !Object.prototype.hasOwnProperty.call(written, key),
        )
        .sort();

    document[policy.noteKey] = {
        stage: policy.stage,
        mergedIntoExisting: Object.keys(base).length > 0,
        preservedKeys,
        preservedSubKeys,
        clearedProvisionalMarkers,
        // Which freshness obligation this write discharged, and which remain.
        // Written on every merge so the marker's lifecycle is legible from the
        // artefact alone: a reader can see that import measured its sections
        // while the report stage still owes its aggregates.
        dischargedFreshnessObligation,
        outstandingFreshnessObligations,
        compoundBlocks: [...compound].sort(),
        basis:
            'This stage replaced the keys it measured and preserved every other key in the document, because the ' +
            'import, generation and report stages all write into this file. The blocks named in compoundBlocks are ' +
            'co-written, so their sub-keys were merged instead of replaced and preservedSubKeys names the ones this ' +
            'write carried forward from another stage.',
    };

    try {
        JSON.stringify(document);
    } catch (error) {
        throw new ManifestError(
            'invalid_merged_report',
            `the ${policy.stage} report cannot be represented as JSON, so nothing was written and the previous ` +
                `artefact is intact: ${(error as Error).message}`,
        );
    }

    return { document, preservedKeys, preservedSubKeys };
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
// THE TWO CLASSES OF LOADER, and the one question that sorts a document into
// them: would a field this document is missing fail where it is USED?
//
// CAST AND VERSION-CHECKED — `loadSearchBenchmark` and `loadReleaseManifest`.
// A missing field in either surfaces in the consuming script: the benchmark's
// queries are iterated and compared, and a release manifest's `files[]` entries
// are checksummed byte for byte by `catalog-load.ts`. Re-validating them here
// would duplicate checks `catalog-validate.ts` and `catalog-load.ts` already
// own, and a hand-authored policy file is reviewed input rather than untrusted
// input.
//
// STRUCTURALLY VERIFIED — `loadEvidenceAllowlist`, `loadUsdaManifest` and
// `loadCoveragePlan`, each because "surfaces in the consuming script" is not
// true of the part of its document that is checked:
//
//   `evidence-allowlist.v1.json` IS the SSRF policy. A `fetchLimits` member
//   that is missing rather than wrong does not throw downstream, it removes a
//   limit — an absent `maxBodyBytes` is no size cap at all — and a
//   `specialPurposeRanges` row whose `cidr` is missing silently drops a range
//   from the non-globally-routable table, which turns every address inside it
//   into an address the fetch path accepts.
//
//   `usda-manifest.v1.json` is the import's whole policy. An entry whose
//   `category` is a typo is filed under a category nothing targets, and a
//   `reviewedSafety` block missing `allergenStatus` reads as `undefined`, which
//   is neither `'known'` nor `'unknown'`. The import completes and reports
//   success against a catalog that is wrong.
//
//   `coverage-plan.v1.json`'s MODEL AND PROMPT fields are metadata — copied
//   into a release manifest, logged, compared — so a wrong type there is
//   written out and shipped instead of raising anything. Only those fields are
//   checked; the plan's counts and bounds are consumed as numbers by code that
//   computes with them, which is where a wrong type fails.
//
// None of those failures is visible in a run's output, so each of the three
// loaders checks the fields its document is made of and refuses it otherwise
// (`invalid_manifest_shape`). None of them re-derives the policy it validates:
// the evidence policy's meaning belongs to `src/services/evidence.logic.ts`,
// and each consuming `*.logic.ts` parser validates the slice it acts on.
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

// ---------------------------------------------------------------------------
// The four closed vocabularies above, as values a structural check can test a
// document against.
//
// Each is written as a `Record<Union, true>` and its member list is read back
// off that object, so the two cannot drift: a member added to the union without
// a key here does not compile, and a key here that is not a union member does
// not compile either. The alternative — a hand-maintained
// `readonly CoverageCategory[]` literal — accepts a list with a member missing,
// and a vocabulary silently short one value is a validator that waves the
// corresponding document entry through. That is the failure this shape rules
// out, and it is the same reason `assertEvidenceAllowlistShape` checks the
// document rather than trusting it.
//
// Declared here rather than imported from `src/services/catalog.logic.ts`,
// whose `CATALOG_FOOD_STATES` covers the same ground: `scripts/` may read
// `src/`, but this module is the one every script loads its inputs through and
// it deliberately imports only Node built-ins and its sibling logger (see the
// scope note at the top). The compile-time exhaustiveness above is what makes
// the restatement safe.
// ---------------------------------------------------------------------------

const COVERAGE_CATEGORY_MEMBERS: Readonly<Record<CoverageCategory, true>> = {
    produce_vegetable: true,
    produce_fruit: true,
    protein_meat: true,
    protein_poultry: true,
    protein_seafood: true,
    protein_egg: true,
    protein_plant: true,
    dairy: true,
    dairy_alternative: true,
    grain: true,
    bread_bakery: true,
    legume: true,
    nut_seed: true,
    oil_fat: true,
    condiment_sauce: true,
    spice_herb: true,
    beverage: true,
    snack: true,
    sweet: true,
    prepared_meal: true,
    other: true,
};

/** The 21 category codes, in declaration order. */
export const COVERAGE_CATEGORIES: readonly CoverageCategory[] = Object.keys(
    COVERAGE_CATEGORY_MEMBERS,
) as readonly CoverageCategory[];

const CATALOG_FOOD_STATE_MEMBERS: Readonly<Record<CatalogFoodState, true>> = {
    raw: true,
    cooked: true,
    prepared: true,
    dry: true,
    as_purchased: true,
};

export const MANIFEST_FOOD_STATES: readonly CatalogFoodState[] = Object.keys(
    CATALOG_FOOD_STATE_MEMBERS,
) as readonly CatalogFoodState[];

const USDA_DATA_TYPE_MEMBERS: Readonly<Record<UsdaDataType, true>> = {
    Foundation: true,
    'SR Legacy': true,
    'Survey (FNDDS)': true,
    Branded: true,
    Experimental: true,
};

export const USDA_DATA_TYPES: readonly UsdaDataType[] = Object.keys(
    USDA_DATA_TYPE_MEMBERS,
) as readonly UsdaDataType[];

const COST_CLASS_MEMBERS: Readonly<Record<CostClass, true>> = { 1: true, 2: true, 3: true };

/**
 * `Object.keys` stringifies numeric keys, so the values are read back through
 * `Number` — a cost class is `1 | 2 | 3` and comparing a document's number
 * against the string `'1'` would reject every valid entry.
 */
export const COST_CLASSES: readonly CostClass[] = Object.keys(COST_CLASS_MEMBERS).map((key) =>
    Number(key),
) as readonly CostClass[];

/**
 * The nine allergen classes this product supports, as the onboarding's
 * multi-select offers them.
 *
 * Declared here rather than read from the manifest because the manifest is the
 * document being validated: checking its `allergenVocabulary` against a list
 * the same document declares accepts a *coherent* truncation — one that drops
 * `milk` from the vocabulary, from the description-marker table, and from every
 * curated entry's `reviewedSafety` in a single edit. Such a document is
 * internally consistent and would import cleanly while silently never tagging
 * that allergen again, which is the failure mode that matters: an allergen
 * class the catalog cannot express is one no exclusion can act on.
 *
 * `NAMED_ALLERGENS` in `src/services/preferences.logic.ts` is the
 * request-validation expression of the same nine classes; the duplication is
 * deliberate, because a manifest check that runs inside a CLI script must not
 * depend on a service module.
 *
 * This constant is not self-certifying either: the import suite asserts it
 * equals a nine-class list written independently of it, and asserts the
 * manifest's vocabulary and marker keys against that same list — so the
 * document, this validator and the requirement all have to agree, and no single
 * edit can move all three.
 */
export type AllergenClass =
    | 'milk'
    | 'eggs'
    | 'peanuts'
    | 'tree_nuts'
    | 'soy'
    | 'wheat'
    | 'fish'
    | 'shellfish'
    | 'sesame';

/**
 * Exhaustive by construction: adding a member to {@link AllergenClass} without
 * listing it here is a compile error, so the supported set cannot drift
 * silently away from the classes the product offers.
 */
const ALLERGEN_CLASS_MEMBERS: Readonly<Record<AllergenClass, true>> = {
    milk: true,
    eggs: true,
    peanuts: true,
    tree_nuts: true,
    soy: true,
    wheat: true,
    fish: true,
    shellfish: true,
    sesame: true,
};

export const ALLERGEN_CLASSES: readonly AllergenClass[] = Object.keys(
    ALLERGEN_CLASS_MEMBERS,
) as readonly AllergenClass[];

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

/**
 * How the coverage plan names a model: the environment variable that selects
 * it, the variable consulted when that one is unset, and the model used when
 * neither is set.
 *
 * It is a CONFIGURATION BLOCK and not a model name, which is the whole point of
 * declaring it. The document has always held an object here
 * (`{"envVar": "CATALOG_GENERATION_MODEL", "fallbackEnvVar": "OPENROUTER_MODEL",
 * "fallbackModel": "google/gemini-2.5-flash"}`) while the type said `string`,
 * and the declarative cast in `loadVersionedManifest` let the two disagree in
 * silence — so `catalog-release.ts` could put this object into a manifest field
 * typed `string | null` and ship it as the model that produced a release's rows.
 * Two things follow from the shape being written down, and both are enforced:
 * `assertCoveragePlanModelShape` refuses a document that does not carry it, and
 * a consumer that reads it can no longer mistake it for evidence of a call —
 * what a run actually invoked is recorded on the batch and review rows it
 * wrote, never here.
 */
export interface CoveragePlanModelConfig {
    /** The variable an operator sets to choose the model. */
    readonly envVar: string;
    /** Consulted when `envVar` is unset; absent where the plan names no second variable. */
    readonly fallbackEnvVar?: string;
    /** Used when neither variable is set. */
    readonly fallbackModel: string;
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
     * How generation and review SELECT a model — an env-var name, its fallback
     * variable and the model used when neither is set. Configuration, and
     * therefore never evidence that a call happened: a release's
     * `model_versions` is measured from the generation batches and `llm_review`
     * records the rows actually carry (see `catalog-release.ts`), and this block
     * is not consulted there at all.
     */
    readonly generationModel?: CoveragePlanModelConfig;
    readonly reviewModel?: CoveragePlanModelConfig;
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

export interface UsdaManifestFood {
    /**
     * The FDC id read from a live USDA response, and the only way a curated
     * entry names its food. REQUIRED, and there is deliberately no second form.
     *
     * An earlier revision declared this optional beside a `resolveBy` lookup
     * specification for an entry whose id could not be verified at authoring
     * time. Nothing ever performed that lookup: `buildImportPlan` counted such
     * an entry under `skippedUnresolvedEntry` and moved on, so a curation a
     * reviewer had approved silently never reached the catalog. The two
     * alternatives are worse — resolving it needs a vendor search whose chosen
     * hit a human has to confirm, and an unattended choice among plausible hits
     * is the fabricated identity the catalog policy forbids, carried into
     * recipes as source-backed nutrition.
     *
     * So verifying the id is a curation step that happens before the document is
     * written, `assertUsdaManifestShape` refuses an entry carrying `resolveBy`
     * by name, and the importer resolves nothing.
     */
    readonly fdcId: number;
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
    /**
     * The coverage plan this manifest's categories, food groups and food states
     * are filed against. Declared — and compared for equality with the loaded
     * plan's own `coveragePlanVersion` before any vendor request — because
     * every taxonomy check the importer runs is only as meaningful as the plan
     * it runs against: validating this manifest against a *different* plan
     * version would pass on headings that version happens to share and file
     * records under headings the intended plan never declared.
     */
    readonly coveragePlanVersion: string;
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
    /**
     * The written rule that every category and food group below exists in the
     * named coverage plan, and that a disagreement stops the run before a USDA
     * request. Declared here so the promise is visible to a reader of the type,
     * and enforced by `assertManifestMatchesCoveragePlan` in
     * `scripts/catalog-import-usda.ts`.
     */
    readonly coveragePlanContract?: string;
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
 * An array whose entries must each be a non-empty string, where the array
 * itself may be empty. Distinct from {@link requireNonEmptyStringArray} on
 * purpose: a curated food legitimately carries no aliases, while an alias
 * written as `""` or as a number is a document error either way.
 */
const requireStringArray = (value: unknown, relativePath: string, field: string): readonly string[] => {
    if (!Array.isArray(value)) {
        throw shapeError(relativePath, `declares ${field} as something other than an array`);
    }
    return value.map((entry, index) => requireNonEmptyString(entry, relativePath, `${field}[${index}]`));
};

const requireBoolean = (value: unknown, relativePath: string, field: string): boolean => {
    if (typeof value !== 'boolean') {
        throw shapeError(relativePath, `declares ${field} as something other than true or false`);
    }
    return value;
};

/**
 * A finite number strictly above zero, for the two fields that are measures
 * rather than counts: a portion's `amount` and its `gramWeight`. Fractional is
 * legitimate there (`0.5 cup`), which is why {@link requireInteger} cannot be
 * used, but zero and negative are not — a zero gram weight is the fabricated
 * weight the catalog policy forbids, wearing a number.
 */
const requirePositiveNumber = (value: unknown, relativePath: string, field: string): number => {
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
        throw shapeError(relativePath, `declares ${field} as something other than a number above zero`);
    }
    return value;
};

/**
 * A value drawn from one of this module's closed vocabularies. The message
 * names the vocabulary rather than just the field, because the operator fix is
 * always "use one of these" and a typo (`tree nuts` for `tree_nuts`) is the
 * common case: a tag outside the vocabulary does not fail at runtime, it simply
 * never matches, and for an allergen tag that is an exclusion that silently
 * stops excluding.
 */
const requireMember = <T>(value: unknown, relativePath: string, field: string, allowed: readonly T[]): T => {
    if (!allowed.some((candidate) => candidate === value)) {
        throw shapeError(
            relativePath,
            `declares ${field} as ${JSON.stringify(value)}, which is not one of ${allowed
                .map((candidate) => String(candidate))
                .join(', ')}`,
        );
    }
    return value as T;
};

/**
 * Membership in both directions, plus uniqueness.
 *
 * {@link requireMember} answers "is this value allowed", which cannot detect an
 * *absent* value — the check every self-declared vocabulary needs, because a
 * document that lists fewer classes than the product supports satisfies every
 * subset check while quietly narrowing what the importer can express.
 */
const requireExactSet = (
    values: readonly string[],
    relativePath: string,
    field: string,
    expected: readonly string[],
): void => {
    const seen = new Set<string>();
    values.forEach((value) => {
        if (seen.has(value)) {
            throw shapeError(relativePath, `lists ${JSON.stringify(value)} more than once in ${field}`);
        }
        seen.add(value);
    });

    const allowed = new Set<string>(expected);
    const unexpected = values.filter((value) => !allowed.has(value));
    const missing = expected.filter((value) => !seen.has(value));
    if (unexpected.length === 0 && missing.length === 0) {
        return;
    }

    const parts: string[] = [];
    if (missing.length > 0) {
        parts.push(`omits ${missing.map((value) => JSON.stringify(value)).join(', ')}`);
    }
    if (unexpected.length > 0) {
        parts.push(`adds ${unexpected.map((value) => JSON.stringify(value)).join(', ')}`);
    }
    throw shapeError(
        relativePath,
        `declares ${field} as a set that ${parts.join(' and ')}; it must be exactly ${expected
            .map((value) => JSON.stringify(value))
            .join(', ')}`,
    );
};

/** An optional field: absent is fine, present is checked. `null` is not absent. */
const optional = <T>(value: unknown, check: (present: unknown) => T): T | undefined =>
    value === undefined ? undefined : check(value);

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
    // the declarative cast the two version-only loaders make (see the two
    // classes of loader above the shapes).
    return value as EvidenceAllowlist;
};

// ---------------------------------------------------------------------------
// `usda-manifest.v1.json`'s structural check — one of the three verified
// narrowings in this module, and for the same reason as the other two: a field
// this document is missing does not fail where it is used.
//
// This document is the import's whole policy: which vendor records are fetched,
// which category and food state each one is filed under, which allergen and
// diet determination a curated food carries, and the vendor limits the run is
// paced against. A version check alone cannot see any of that. An entry whose
// `category` is a typo is filed under a category nothing targets; an
// `allergenTags` entry spelled `tree nuts` never matches the exclusion it was
// written for; a `reviewedSafety` block missing `allergenStatus` reads as
// `undefined`, which is not `'known'` and not `'unknown'` either. None of those
// fails at runtime — the import completes and reports success against a catalog
// that is wrong in a way no counter shows.
//
// The check is deliberately DOCUMENT-INTERNAL: every vocabulary it tests
// against is either one of this module's four compile-time-exhaustive lists or
// a vocabulary the document itself declares (`sweepAllergenDietRules`). The
// cross-FILE agreement the document's own `coveragePlanContract` states — every
// `category` and `foodGroup` existing in the coverage plan, and each entry's
// category equalling that food group's category there — needs the coverage plan
// loaded, so it belongs to the importer, which asserts it before its first
// vendor request. Splitting it this way keeps this loader free of a dependency
// on a second document's load order.
// ---------------------------------------------------------------------------

/** `foods[12] (kale, raw)` — an operator has to find the entry, not just the field. */
const describeFoodEntry = (index: number, entry: Record<string, unknown>): string => {
    const name = typeof entry.canonicalName === 'string' && entry.canonicalName.length > 0 ? entry.canonicalName : '?';
    const state = typeof entry.foodState === 'string' && entry.foodState.length > 0 ? entry.foodState : '?';
    return `foods[${index}] (${name}, ${state})`;
};

/**
 * Exactly one of two match fields, which is what the document's own `matching`
 * note states. Both is ambiguous — the reader cannot tell which was intended —
 * and neither is an inert rule that matches nothing, silently shrinking the
 * table a reviewer believes they approved.
 */
const requireOneMatchField = (
    rule: Record<string, unknown>,
    relativePath: string,
    field: string,
    fields: readonly string[],
): void => {
    const present = fields.filter((name) => rule[name] !== undefined);
    if (present.length !== 1) {
        throw shapeError(
            relativePath,
            `declares ${field} with ${present.length === 0 ? 'neither' : 'both'} of ${fields.join(
                ' and ',
            )}, where the document's own matching note requires exactly one`,
        );
    }
    present.forEach((name) => requireNonEmptyStringArray(rule[name], relativePath, `${field}.${name}`));
};

const assertSweepAllergenDietRules = (
    value: unknown,
    relativePath: string,
): { readonly allergens: readonly string[]; readonly dietTags: readonly string[] } => {
    const rules = requireRecord(value, relativePath, 'sweepAllergenDietRules');

    const allergens = requireNonEmptyStringArray(
        rules.allergenVocabulary,
        relativePath,
        'sweepAllergenDietRules.allergenVocabulary',
    );
    // Against {@link ALLERGEN_CLASSES}, not against itself: every other check in
    // this function reads `allergens` as the authority, so a document that
    // dropped a class here would take its marker table and its curated entries
    // down with it and still validate.
    requireExactSet(
        allergens,
        relativePath,
        'sweepAllergenDietRules.allergenVocabulary',
        ALLERGEN_CLASSES,
    );
    const dietTags = requireNonEmptyStringArray(
        rules.dietTagVocabulary,
        relativePath,
        'sweepAllergenDietRules.dietTagVocabulary',
    );

    const byFoodGroup = requireRecord(rules.byFoodGroup, relativePath, 'sweepAllergenDietRules.byFoodGroup');
    Object.entries(byFoodGroup).forEach(([foodGroup, tags]) => {
        requireStringArray(tags, relativePath, `sweepAllergenDietRules.byFoodGroup.${foodGroup}`).forEach(
            (tag, index) => {
                requireMember(
                    tag,
                    relativePath,
                    `sweepAllergenDietRules.byFoodGroup.${foodGroup}[${index}]`,
                    allergens,
                );
            },
        );
    });

    // The KEYS of this map are allergen classes, and a key outside the
    // vocabulary is the failure that matters here: the markers under it are
    // still matched, and the tag they then write is one no exclusion reads.
    const markers = requireRecord(
        rules.descriptionAllergenMarkers,
        relativePath,
        'sweepAllergenDietRules.descriptionAllergenMarkers',
    );
    Object.entries(markers).forEach(([allergen, tokens]) => {
        requireMember(
            allergen,
            relativePath,
            `sweepAllergenDietRules.descriptionAllergenMarkers key ${JSON.stringify(allergen)}`,
            allergens,
        );
        requireNonEmptyStringArray(
            tokens,
            relativePath,
            `sweepAllergenDietRules.descriptionAllergenMarkers.${allergen}`,
        );
    });
    // Every class needs at least one marker. A class present in the vocabulary
    // but absent from this table is only reachable through `byFoodGroup`, and
    // the sweep's food groups are coarser than its allergens — so the class
    // would go untagged on any record whose group does not seed it, which reads
    // as "contains no milk" rather than "not determined".
    requireExactSet(
        Object.keys(markers),
        relativePath,
        'sweepAllergenDietRules.descriptionAllergenMarkers keys',
        ALLERGEN_CLASSES,
    );

    const derivation = requireRecord(
        rules.dietDerivation,
        relativePath,
        'sweepAllergenDietRules.dietDerivation',
    );
    requireNonEmptyStringArray(
        derivation.animalCategories,
        relativePath,
        'sweepAllergenDietRules.dietDerivation.animalCategories',
    ).forEach((category, index) => {
        requireMember(
            category,
            relativePath,
            `sweepAllergenDietRules.dietDerivation.animalCategories[${index}]`,
            COVERAGE_CATEGORIES,
        );
    });
    requireNonEmptyStringArray(
        derivation.animalMarkers,
        relativePath,
        'sweepAllergenDietRules.dietDerivation.animalMarkers',
    );
    requireNonEmptyStringArray(
        derivation.seafoodMarkers,
        relativePath,
        'sweepAllergenDietRules.dietDerivation.seafoodMarkers',
    );
    requireNonEmptyStringArray(
        derivation.dairyEggMarkers,
        relativePath,
        'sweepAllergenDietRules.dietDerivation.dairyEggMarkers',
    );

    const composite = requireRecord(
        rules.compositeMarkers,
        relativePath,
        'sweepAllergenDietRules.compositeMarkers',
    );
    requireNonEmptyStringArray(
        composite.markers,
        relativePath,
        'sweepAllergenDietRules.compositeMarkers.markers',
    );

    return { allergens, dietTags };
};

const assertUsdaManifestFood = (
    entry: unknown,
    index: number,
    relativePath: string,
    vocabularies: { readonly allergens: readonly string[]; readonly dietTags: readonly string[] },
): void => {
    const food = requireRecord(entry, relativePath, `foods[${index}]`);
    const where = describeFoodEntry(index, food);

    // THE IDENTITY RULE. A curated entry names its food by an FDC id read from a
    // live USDA response, and this importer resolves nothing.
    //
    // The `resolveBy` form is refused rather than skipped. Resolving one means a
    // vendor search whose chosen hit a human has to confirm, and there is no
    // unattended reading of "the search returned three plausible foods" that is
    // safe: importing the wrong record under a name that looks right is exactly
    // the fabricated identity the catalog policy forbids, and it would then
    // carry that record's nutrition into recipes as source-backed. Skipping the
    // entry is no better — it is a curation a reviewer approved that never
    // reaches the catalog, visible only as a counter nobody reads.
    //
    // So the document may not carry the form at all, and an append that needs a
    // food whose id cannot be verified at authoring time is a curation task
    // (verify the id, then append it), not an import-time lookup.
    if (food.resolveBy !== undefined) {
        throw shapeError(
            relativePath,
            `declares ${where} with resolveBy instead of a verified fdcId. This importer resolves no entry: the ` +
                'lookup needs a vendor search whose chosen hit a human has to confirm, and importing the wrong ' +
                'record under a name that looks right is the fabricated identity the catalog policy forbids. ' +
                'Verify the id against a live USDA response and write it as fdcId, or remove the entry',
        );
    }

    requireInteger(food.fdcId, relativePath, `${where} fdcId`, 1);
    requireMember(food.usdaDataType, relativePath, `${where} usdaDataType`, USDA_DATA_TYPES);
    optional(food.expectedUsdaDescription, (present) =>
        requireNonEmptyString(present, relativePath, `${where} expectedUsdaDescription`),
    );
    requireMember(food.category, relativePath, `${where} category`, COVERAGE_CATEGORIES);
    requireMember(food.foodState, relativePath, `${where} foodState`, MANIFEST_FOOD_STATES);
    requireNonEmptyString(food.canonicalName, relativePath, `${where} canonicalName`);
    requireNonEmptyString(food.displayName, relativePath, `${where} displayName`);
    // An alias-less food is legitimate; an alias written as `""` is not.
    requireStringArray(food.aliases, relativePath, `${where} aliases`);
    requireNonEmptyString(food.foodGroup, relativePath, `${where} foodGroup`);

    // The selector carries no gram weight BY DESIGN — the weight is USDA's to
    // state — so there is deliberately no gramWeight field to check here.
    const portion = requireRecord(food.defaultPortion, relativePath, `${where} defaultPortion`);
    requireNonEmptyString(portion.description, relativePath, `${where} defaultPortion.description`);
    optional(portion.amount, (present) =>
        requirePositiveNumber(present, relativePath, `${where} defaultPortion.amount`),
    );
    optional(portion.unit, (present) => requireNonEmptyString(present, relativePath, `${where} defaultPortion.unit`));
    optional(portion.portionDescription, (present) =>
        requireNonEmptyString(present, relativePath, `${where} defaultPortion.portionDescription`),
    );
    optional(portion.modifier, (present) =>
        requireNonEmptyString(present, relativePath, `${where} defaultPortion.modifier`),
    );

    requireMember(food.costClass, relativePath, `${where} costClass`, COST_CLASSES);
    requireBoolean(food.isCommonDislike, relativePath, `${where} isCommonDislike`);

    // The reviewed determination is the ONLY source of a curated food's safety
    // metadata (the document's `curatedSafetyContract`), and an empty
    // `allergenTags` list under `allergenStatus: 'known'` is itself the claim
    // "reviewed, and this food contains none of the nine". So the block is
    // checked field by field where it exists: a missing `allergenStatus` would
    // read as neither 'known' nor 'unknown', and a tag outside the vocabulary
    // would be written to the row and matched by nothing.
    optional(food.reviewedSafety, (present) => {
        const safety = requireRecord(present, relativePath, `${where} reviewedSafety`);
        requireMember(safety.allergenStatus, relativePath, `${where} reviewedSafety.allergenStatus`, [
            'known',
            'unknown',
        ]);
        requireStringArray(safety.allergenTags, relativePath, `${where} reviewedSafety.allergenTags`).forEach(
            (tag, tagIndex) => {
                requireMember(
                    tag,
                    relativePath,
                    `${where} reviewedSafety.allergenTags[${tagIndex}]`,
                    vocabularies.allergens,
                );
            },
        );
        requireStringArray(safety.dietTags, relativePath, `${where} reviewedSafety.dietTags`).forEach(
            (tag, tagIndex) => {
                requireMember(
                    tag,
                    relativePath,
                    `${where} reviewedSafety.dietTags[${tagIndex}]`,
                    vocabularies.dietTags,
                );
            },
        );
        optional(safety.note, (note) => requireNonEmptyString(note, relativePath, `${where} reviewedSafety.note`));
        return safety;
    });
};

const assertUsdaDatasetSweep = (
    entry: unknown,
    index: number,
    relativePath: string,
    limits: { readonly maxListPageSize: number },
    foodStateDataTypes: ReadonlySet<string>,
): string => {
    const sweep = requireRecord(entry, relativePath, `datasetSweeps[${index}]`);
    const key = requireNonEmptyString(sweep.sweepKey, relativePath, `datasetSweeps[${index}].sweepKey`);
    const where = `datasetSweeps[${index}] (${key})`;

    const dataType = requireMember(sweep.dataType, relativePath, `${where} dataType`, USDA_DATA_TYPES);
    optional(sweep.category, (present) =>
        requireMember(present, relativePath, `${where} category`, COVERAGE_CATEGORIES),
    );
    requireNonEmptyString(sweep.listEndpoint, relativePath, `${where} listEndpoint`);

    const pageSize = requireInteger(sweep.pageSize, relativePath, `${where} pageSize`, 1);
    // The vendor's own ceiling on `/foods/list`. A page size above it is not a
    // bigger page — it is a request USDA rejects, for every page of the sweep.
    if (pageSize > limits.maxListPageSize) {
        throw shapeError(
            relativePath,
            `declares ${where} pageSize ${pageSize}, above importLimits.maxListPageSize ${limits.maxListPageSize}`,
        );
    }

    const maxPages = requireInteger(sweep.maxPages, relativePath, `${where} maxPages`, 1);
    const observedLastPage = optional(sweep.observedLastNonEmptyPage, (present) =>
        requireInteger(present, relativePath, `${where} observedLastNonEmptyPage`, 1),
    );
    // The document's own `sweepPageBounds` states that `maxPages` "sits above
    // the observed count so a dataset that grows between authoring and import is
    // not silently truncated". `maxPages` is the sweep's only page bound — the
    // importer enumerates to it and stops on the first empty page — so a
    // `maxPages` at or below the last page already measured is a document that
    // truncates the dataset it documents.
    if (observedLastPage !== undefined && maxPages < observedLastPage) {
        throw shapeError(
            relativePath,
            `declares ${where} maxPages ${maxPages} below its own observedLastNonEmptyPage ${observedLastPage}, ` +
                'so the sweep would stop before the data it has already been measured to hold',
        );
    }
    optional(sweep.observedApproximateRecordCount, (present) =>
        requireInteger(present, relativePath, `${where} observedApproximateRecordCount`, 0),
    );
    optional(sweep.observedOn, (present) => requireNonEmptyString(present, relativePath, `${where} observedOn`));

    const detailFetch = requireRecord(sweep.detailFetch, relativePath, `${where} detailFetch`);
    requireNonEmptyString(detailFetch.endpoint, relativePath, `${where} detailFetch.endpoint`);
    requireNonEmptyString(detailFetch.method, relativePath, `${where} detailFetch.method`);
    requireInteger(detailFetch.batchSize, relativePath, `${where} detailFetch.batchSize`, 1);

    optional(sweep.skipFdcIdsPresentInFoods, (present) =>
        requireBoolean(present, relativePath, `${where} skipFdcIdsPresentInFoods`),
    );
    optional(sweep.stopWhenCategoryCandidateVolumeReached, (present) =>
        requireBoolean(present, relativePath, `${where} stopWhenCategoryCandidateVolumeReached`),
    );

    // `resolveFoodState` ends in a hard `as_purchased`, so a sweep whose dataset
    // has no fallback entry does not fail: every unmatched record in it is filed
    // `as_purchased`, which for FNDDS (as-eaten descriptions) is wrong for the
    // whole sweep and shows up nowhere.
    if (!foodStateDataTypes.has(dataType)) {
        throw shapeError(
            relativePath,
            `declares ${where} over dataType ${dataType}, which sweepFoodStateRules.datasetFallback does not cover, ` +
                'so every unmatched record in the sweep would take the module default instead of the dataset default',
        );
    }

    return key;
};

/**
 * Refuses `usda-manifest.v1.json` unless it carries every field the declared
 * {@link UsdaManifest} shape promises, with every closed-vocabulary value drawn
 * from its vocabulary, and returns it typed.
 *
 * Verified in place and returned as-is rather than rebuilt from the checked
 * fields, exactly as {@link assertEvidenceAllowlistShape} is: a reviewed
 * addition to the document still reaches the script that wants it instead of
 * being quietly dropped here.
 */
export const assertUsdaManifestShape = (value: unknown, relativePath: string): UsdaManifest => {
    const document = requireRecord(value, relativePath, 'its top level');

    requireNonEmptyString(document.usdaManifestVersion, relativePath, 'usdaManifestVersion');
    // Required, not optional: the cross-plan taxonomy check has nothing to
    // compare against without it, and an absent field would silently downgrade
    // that check to "whichever plan the caller happened to load".
    requireNonEmptyString(document.coveragePlanVersion, relativePath, 'coveragePlanVersion');
    requireNonEmptyString(document.sourceKeyFormat, relativePath, 'sourceKeyFormat');
    requireNonEmptyString(document.caloriesFallback, relativePath, 'caloriesFallback');
    optional(document.curatedSafetyContract, (present) =>
        requireNonEmptyString(present, relativePath, 'curatedSafetyContract'),
    );
    optional(document.coveragePlanContract, (present) =>
        requireNonEmptyString(present, relativePath, 'coveragePlanContract'),
    );

    // The four nutrient numbers are what every macro is read from. A missing one
    // is not a missing field at runtime — it is `undefined` handed to a lookup,
    // which finds no nutrient and reports the food as missing that macro.
    const nutrients = requireRecord(document.nutrientNumbers, relativePath, 'nutrientNumbers');
    requireNonEmptyString(nutrients.protein, relativePath, 'nutrientNumbers.protein');
    requireNonEmptyString(nutrients.fat, relativePath, 'nutrientNumbers.fat');
    requireNonEmptyString(nutrients.carbs, relativePath, 'nutrientNumbers.carbs');
    requireNonEmptyString(nutrients.calories, relativePath, 'nutrientNumbers.calories');

    const limits = requireRecord(document.importLimits, relativePath, 'importLimits');
    const vendorRate = requireInteger(limits.vendorRequestsPerHour, relativePath, 'importLimits.vendorRequestsPerHour', 1);
    const configuredRate = requireInteger(
        limits.configuredRequestsPerHour,
        relativePath,
        'importLimits.configuredRequestsPerHour',
        1,
    );
    // The headroom the document's own `rateLimitHeadroomReason` states: the
    // running API shares this key for label scanning and branded search, so a
    // configured rate at or above the vendor cap starves live requests rather
    // than pacing the import.
    if (configuredRate > vendorRate) {
        throw shapeError(
            relativePath,
            `declares importLimits.configuredRequestsPerHour ${configuredRate} above ` +
                `vendorRequestsPerHour ${vendorRate}, which leaves the running API no headroom on the shared key`,
        );
    }
    requireInteger(limits.detailBatchSize, relativePath, 'importLimits.detailBatchSize', 1);
    const maxListPageSize = requireInteger(limits.maxListPageSize, relativePath, 'importLimits.maxListPageSize', 1);

    // Checked before `foods` and `datasetSweeps`, because both are validated
    // against vocabularies this block declares.
    const vocabularies = assertSweepAllergenDietRules(document.sweepAllergenDietRules, relativePath);

    const classification = requireRecord(
        document.sweepClassificationRules,
        relativePath,
        'sweepClassificationRules',
    );
    requireNonEmptyArray(classification.rules, relativePath, 'sweepClassificationRules.rules').forEach(
        (entry, index) => {
            const rule = requireRecord(entry, relativePath, `sweepClassificationRules.rules[${index}]`);
            requireOneMatchField(rule, relativePath, `sweepClassificationRules.rules[${index}]`, [
                'descriptionStartsWith',
                'descriptionContains',
            ]);
            requireMember(
                rule.category,
                relativePath,
                `sweepClassificationRules.rules[${index}].category`,
                COVERAGE_CATEGORIES,
            );
            requireNonEmptyString(
                rule.foodGroup,
                relativePath,
                `sweepClassificationRules.rules[${index}].foodGroup`,
            );
            optional(rule.excludeFromPublication, (present) =>
                requireBoolean(
                    present,
                    relativePath,
                    `sweepClassificationRules.rules[${index}].excludeFromPublication`,
                ),
            );
            optional(rule.appendedBy, (present) =>
                requireNonEmptyString(present, relativePath, `sweepClassificationRules.rules[${index}].appendedBy`),
            );
            return rule;
        },
    );
    const fallback = requireRecord(classification.fallback, relativePath, 'sweepClassificationRules.fallback');
    requireMember(fallback.category, relativePath, 'sweepClassificationRules.fallback.category', COVERAGE_CATEGORIES);
    requireNonEmptyString(fallback.foodGroup, relativePath, 'sweepClassificationRules.fallback.foodGroup');
    requireBoolean(
        fallback.requiresCuratorReview,
        relativePath,
        'sweepClassificationRules.fallback.requiresCuratorReview',
    );
    requireNonEmptyString(fallback.reason, relativePath, 'sweepClassificationRules.fallback.reason');

    const foodStates = requireRecord(document.sweepFoodStateRules, relativePath, 'sweepFoodStateRules');
    requireNonEmptyArray(foodStates.rules, relativePath, 'sweepFoodStateRules.rules').forEach((entry, index) => {
        const rule = requireRecord(entry, relativePath, `sweepFoodStateRules.rules[${index}]`);
        requireOneMatchField(rule, relativePath, `sweepFoodStateRules.rules[${index}]`, [
            'descriptionStartsWith',
            'descriptionContains',
        ]);
        requireMember(
            rule.foodState,
            relativePath,
            `sweepFoodStateRules.rules[${index}].foodState`,
            MANIFEST_FOOD_STATES,
        );
        return rule;
    });
    const foodStateDataTypes = new Set<string>();
    requireNonEmptyArray(
        foodStates.datasetFallback,
        relativePath,
        'sweepFoodStateRules.datasetFallback',
    ).forEach((entry, index) => {
        const row = requireRecord(entry, relativePath, `sweepFoodStateRules.datasetFallback[${index}]`);
        foodStateDataTypes.add(
            requireMember(
                row.dataType,
                relativePath,
                `sweepFoodStateRules.datasetFallback[${index}].dataType`,
                USDA_DATA_TYPES,
            ),
        );
        requireMember(
            row.foodState,
            relativePath,
            `sweepFoodStateRules.datasetFallback[${index}].foodState`,
            MANIFEST_FOOD_STATES,
        );
        return row;
    });

    const brand = requireRecord(document.sweepBrandExclusionRules, relativePath, 'sweepBrandExclusionRules');
    const signals = requireRecord(brand.signals, relativePath, 'sweepBrandExclusionRules.signals');
    requireNonEmptyStringArray(
        signals.trademarkSymbols,
        relativePath,
        'sweepBrandExclusionRules.signals.trademarkSymbols',
    );
    requireNonEmptyStringArray(
        signals.brandWordContains,
        relativePath,
        'sweepBrandExclusionRules.signals.brandWordContains',
    );
    const allCaps = requireRecord(signals.allCapsRun, relativePath, 'sweepBrandExclusionRules.signals.allCapsRun');
    requireInteger(
        allCaps.minimumLetters,
        relativePath,
        'sweepBrandExclusionRules.signals.allCapsRun.minimumLetters',
        1,
    );
    // The allowlist may legitimately be empty (screen every all-caps run); its
    // entries may not be empty strings, which would match nothing.
    requireStringArray(
        allCaps.allowedAllCaps,
        relativePath,
        'sweepBrandExclusionRules.signals.allCapsRun.allowedAllCaps',
    );

    const cost = requireRecord(document.sweepCostClassRules, relativePath, 'sweepCostClassRules');
    const costByCategory = requireRecord(cost.byCategory, relativePath, 'sweepCostClassRules.byCategory');
    Object.entries(costByCategory).forEach(([category, costClass]) => {
        requireMember(
            category,
            relativePath,
            `sweepCostClassRules.byCategory key ${JSON.stringify(category)}`,
            COVERAGE_CATEGORIES,
        );
        requireMember(costClass, relativePath, `sweepCostClassRules.byCategory.${category}`, COST_CLASSES);
    });
    const costOverrides = requireRecord(
        cost.foodGroupOverrides,
        relativePath,
        'sweepCostClassRules.foodGroupOverrides',
    );
    Object.entries(costOverrides).forEach(([foodGroup, costClass]) => {
        requireMember(costClass, relativePath, `sweepCostClassRules.foodGroupOverrides.${foodGroup}`, COST_CLASSES);
    });

    const portionPolicy = requireRecord(document.sweepPortionPolicy, relativePath, 'sweepPortionPolicy');
    const basis = requireRecord(portionPolicy.basisPortion, relativePath, 'sweepPortionPolicy.basisPortion');
    requireNonEmptyString(basis.description, relativePath, 'sweepPortionPolicy.basisPortion.description');
    requirePositiveNumber(basis.amount, relativePath, 'sweepPortionPolicy.basisPortion.amount');
    requireNonEmptyString(basis.unit, relativePath, 'sweepPortionPolicy.basisPortion.unit');
    requirePositiveNumber(basis.gramWeight, relativePath, 'sweepPortionPolicy.basisPortion.gramWeight');
    requireNonEmptyString(basis.source, relativePath, 'sweepPortionPolicy.basisPortion.source');
    requireBoolean(
        basis.isDefaultWhenNoHouseholdPortion,
        relativePath,
        'sweepPortionPolicy.basisPortion.isDefaultWhenNoHouseholdPortion',
    );

    const sweepKeys = new Set<string>();
    requireNonEmptyArray(document.datasetSweeps, relativePath, 'datasetSweeps').forEach((entry, index) => {
        const key = assertUsdaDatasetSweep(entry, index, relativePath, { maxListPageSize }, foodStateDataTypes);
        // A sweep key names a batch in the checkpoint and a row in the report,
        // so two sweeps sharing one make a resumed run and its report ambiguous.
        if (sweepKeys.has(key)) {
            throw shapeError(relativePath, `declares datasetSweeps[${index}] under the sweepKey ${key} a second time`);
        }
        sweepKeys.add(key);
    });

    const fdcIds = new Set<number>();
    const identities = new Set<string>();
    requireNonEmptyArray(document.foods, relativePath, 'foods').forEach((entry, index) => {
        assertUsdaManifestFood(entry, index, relativePath, vocabularies);

        // Both duplicates below are curation mistakes the import would absorb
        // rather than report: the plan keeps the first entry for an id and
        // counts the rest under `skippedDuplicateInPlan`, so a second, different
        // curation of one vendor record simply never takes effect. The identity
        // pair is compared as written — normalising it is
        // `catalog.logic.ts::normalizeCanonicalName`'s job and this module
        // depends on nothing in `src/` — so this catches an exact repeat and the
        // validator's near-miss cases are left to that function downstream.
        const food = entry as Record<string, unknown>;
        const fdcId = food.fdcId as number;
        if (fdcIds.has(fdcId)) {
            throw shapeError(
                relativePath,
                `declares ${describeFoodEntry(index, food)} under fdcId ${fdcId}, which an earlier entry already claims`,
            );
        }
        fdcIds.add(fdcId);

        const identity = `${String(food.canonicalName)}\u0000${String(food.foodState)}`;
        if (identities.has(identity)) {
            throw shapeError(
                relativePath,
                `declares ${describeFoodEntry(index, food)} a second time: canonicalName and foodState together are ` +
                    'the published identity, so two entries sharing them cannot both publish',
            );
        }
        identities.add(identity);
    });

    // Every member the declared type promises has now been checked against the
    // document itself. The cross-file half — the coverage plan's categories and
    // food groups — is the importer's, before its first vendor request.
    return value as UsdaManifest;
};

/**
 * Refuses `coverage-plan.v1.json` unless its MODEL AND PROMPT fields carry the
 * shape the declared `CoveragePlan` promises, and returns it typed.
 *
 * Narrow on purpose, and the narrowness is the finding it closes rather than an
 * omission. The plan's counts and bounds are consumed as numbers by code that
 * computes with them, so a wrong type there fails where it is used; these five
 * fields are consumed as METADATA — copied into a release manifest, logged,
 * compared — and a wrong type there is written out and shipped instead of
 * raising anything. Version-only loading is exactly what let
 * `{"envVar": …, "fallbackModel": …}` be declared as `string` and reach a
 * manifest field typed `string | null`.
 *
 * Verified in place and returned as-is, like `assertEvidenceAllowlistShape`, so
 * a reviewed addition to the document still reaches the script that wants it.
 *
 * The rest of the plan's shape is not re-derived here: doing so would put a
 * second copy of the policy in this module, and each consuming `*.logic.ts`
 * parser already validates the slice it acts on.
 */
export const assertCoveragePlanModelShape = (value: unknown, relativePath: string): CoveragePlan => {
    const document = requireRecord(value, relativePath, 'its top level');

    // Both prompt versions are recorded as provenance on generated rows and on
    // advisory review records, so an absent or non-string one is a run that
    // would stamp `undefined` onto evidence.
    requireNonEmptyString(document.promptVersion, relativePath, 'promptVersion');
    requireNonEmptyString(document.reviewPromptVersion, relativePath, 'reviewPromptVersion');

    // Optional in the type because a plan may leave a stage's model entirely to
    // the environment; present-but-malformed is what must not pass.
    for (const field of ['generationModel', 'reviewModel'] as const) {
        const declared = document[field];
        if (declared === undefined) {
            continue;
        }
        const config = requireRecord(declared, relativePath, field);
        requireNonEmptyString(config.envVar, relativePath, `${field}.envVar`);
        requireNonEmptyString(config.fallbackModel, relativePath, `${field}.fallbackModel`);
        if (config.fallbackEnvVar !== undefined) {
            requireNonEmptyString(config.fallbackEnvVar, relativePath, `${field}.fallbackEnvVar`);
        }
    }

    return value as CoveragePlan;
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
/**
 * What a release says about the models and prompts that produced the rows it
 * carries.
 *
 * MEASURED FROM THE ROWS, NEVER RESTATED FROM CONFIGURATION, and the shape is
 * what makes that checkable. Each singular field holds one value only when the
 * release carries exactly ONE, and `null` otherwise — including when several
 * are present, because "one of the two models that produced this release" is
 * not an answer, and picking the greater of them was how a release came to
 * attribute every row to one model it was not all produced by. The plural field
 * beside it carries the COMPLETE sorted set, so a release spanning two
 * generation runs states both rather than losing one, and an empty array is the
 * measurement "no such call is recorded against any row in this release".
 *
 * `catalog-release.ts` derives every field from the exported rows' generation
 * batches and `llm_review` records and asserts before writing that nothing here
 * is an object; the coverage plan's model blocks are configuration and are not
 * consulted.
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
    /**
     * The complete measured sets, sorted. Optional: only a manifest written
     * after these fields existed carries them, and a reader holding an older
     * one still has the singular fields it always had.
     */
    readonly generation_models?: readonly string[];
    readonly review_models?: readonly string[];
    readonly generation_prompt_versions?: readonly string[];
    readonly review_prompt_versions?: readonly string[];
    /** How many exported rows each set was measured from. */
    readonly ai_generated_foods?: number;
    readonly reviewed_foods?: number;
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
 * Three of the five loaders pass one — `loadEvidenceAllowlist`,
 * `loadUsdaManifest` and `loadCoveragePlan` — and the reason each of those
 * documents is verified rather than cast is written out above its check.
 * `loadSearchBenchmark` and `loadReleaseManifest` pass none, because a field
 * missing from either fails where it is used.
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
    loadVersionedManifest<CoveragePlan>(
        dataPath(COVERAGE_PLAN_FILE),
        [{ field: COVERAGE_PLAN_VERSION_FIELD, expected: EXPECTED_COVERAGE_PLAN_VERSION }],
        // The model and prompt fields are checked rather than declared: they are
        // consumed as metadata, so a type the document does not honour is
        // written out instead of raising anything (see the check).
        assertCoveragePlanModelShape,
    );

export const loadUsdaManifest = (): UsdaManifest =>
    loadVersionedManifest<UsdaManifest>(
        dataPath(USDA_MANIFEST_FILE),
        [{ field: USDA_MANIFEST_VERSION_FIELD, expected: EXPECTED_USDA_MANIFEST_VERSION }],
        // Structurally verified rather than declared: this file is the
        // import's whole policy, and a field missing from it — a category, a
        // food state, an allergen determination — does not fail the run. It
        // completes against a catalog that is wrong in a way no counter shows.
        // See the note above the check.
        assertUsdaManifestShape,
    );

export const loadSearchBenchmark = (): SearchBenchmark =>
    loadVersionedManifest<SearchBenchmark>(dataPath(SEARCH_BENCHMARK_FILE), [
        { field: SEARCH_BENCHMARK_VERSION_FIELD, expected: EXPECTED_SEARCH_BENCHMARK_VERSION },
    ]);

export const loadEvidenceAllowlist = (): EvidenceAllowlist =>
    loadVersionedManifest<EvidenceAllowlist>(
        dataPath(EVIDENCE_ALLOWLIST_FILE),
        [{ field: EVIDENCE_ALLOWLIST_VERSION_FIELD, expected: EXPECTED_EVIDENCE_ALLOWLIST_VERSION }],
        // Structurally verified rather than declared: this file is the SSRF
        // policy, and a field missing from it removes a limit instead of
        // raising one.
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
