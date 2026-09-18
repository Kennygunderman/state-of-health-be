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
// The same invariant is asserted in the other direction, because both halves
// are needed for the member to mean anything: a published row that CARRIES
// component rows while declaring any other provenance states two incompatible
// things about where its nutrition came from, and is refused with its offenders
// named. Publishing it would put a release into review whose parent scalars
// nothing has compared with its own composition — which is exactly what
// catalog-load.ts then refuses (`parent_provenance_disagrees`), so the release
// would be unloadable everywhere.
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
// ReleaseIntegrityError and nothing is written. The record also has to BE
// evidence: `assessIdentityEvidence` (scripts/lib/catalogEvidence.ts, the rule
// the import, validation and load stages apply to the same records) is run over
// each published row's identity evidence as it is emitted, and a record missing
// an observed 2xx status, a body digest, a matched snippet, a fetched-at or —
// for a USDA row — its cache key and per-food digest refuses the export the
// same way. This stage additionally RESOLVES what a USDA record's digests stand
// for, which no other stage can: `assessSourceCacheBinding` reads the
// `usda_api_cache` payload the record cites, recomputes both digests from it
// and requires the record it hashed to belong to this food's `usda_fdc_id`, so
// a well-formed digest of nothing is refused here or nowhere. The import stage already
// quarantines exactly that row (AAP §0.3.2, §0.7.3), and this is the last point
// at which the set being shipped is the set being examined, so a release can
// never again freeze rows the pipeline itself declares unpublishable behind the
// manifest's digests. The manifest's `evidence` block states the verdict —
// published rows per identity source, the observed status range and the gap
// histogram — so the property is readable without streaming 56 MB of records,
// and catalog-load.ts cross-checks it. The per-category coverage
// shortfall is reported exactly, never rounded and never omitted: a shortfall
// is an unmet requirement, and a release that hides one is worse than a
// release that states it.
//
// THE OVERWRITE RULE is checked here rather than at write time, because a
// release directory is a reviewed artefact: writing over one silently would
// replace a checksummed release that another environment may already have
// loaded. An existing directory is refused unless the operator passes --force.
//
// WHERE THE BYTES LIVE BEFORE THEY ARE A RELEASE, AND WHY THAT PATH IS NOT
// GUESSABLE. --out accepts any directory, so the parent the six members are
// staged in may be one another local principal can write names into. Every
// member is therefore written into a staging directory this run CREATES: its
// name carries 16 hex characters from the CSPRNG, it is created with a
// non-recursive mkdir under a parent held to lib/manifest.ts's
// `assertSafeArtifactParent`, and an entry already at that name — a symbolic
// link most of all — fails the create instead of being adopted and written
// through. Nothing is removed at a predictable name before the create, because
// there is no longer a predictable name to remove. Member and manifest writes
// are exclusive no-follow opens for the same reason.
//
// THE PATH IS PHYSICAL AND ITS IDENTITY IS RE-ESTABLISHED, NOT ASSUMED. Both
// the repository's releases tree and an --out root are resolved through every
// symbolic link on them once, in `resolveReleaseDir`, so no ancestor link
// survives into the paths the guards below are applied to. The staging
// directory's dev/ino identity is then captured when it is created and
// re-verified immediately before EVERY path-based member operation — each
// member open, each read-back, the manifest write — and again immediately
// before the rename that publishes it. O_NOFOLLOW settles only a member's own
// last component; only those re-checks settle the directory the member name is
// resolved through, and they are what makes the directory that becomes the
// release the one this run exported into.
//
// The two guard imports are ordered and load-bearing: Rule
// backend-architecture §10's IPv4-first DNS ordering, then dbGuard's
// module-load classification of DATABASE_URL, both ahead of anything that
// could reach Prisma or the network.
import './lib/bootstrap';
import './lib/dbGuard';

import fs from 'fs';
import path from 'path';

import { classifyDatabaseOrigin, DatabaseOriginError, originLogFields } from './lib/dbGuard';
import { createFatalLogger, createLogger, isThrownInstanceOf, safeError, writeLineSync } from './lib/logger';
import type { LogFields, LogLevel, SafeErrorFields } from './lib/logger';
import {
    ManifestError,
    assertReleaseVersion,
    assertSafeArtifactParent,
    assertSafePathSegment,
    createExclusiveDirectory,
    loadCoveragePlan,
    openArtifactForWriteSync,
    physicalPathIdentity,
    readArtifactFileNoFollow,
    releaseDir,
    unguessableSuffix,
} from './lib/manifest';
import type {
    CatalogReleaseManifest,
    CatalogReleaseModelVersions,
    CoverageCategory,
    CoveragePlan,
} from './lib/manifest';
import { ModelBudgetError } from './lib/budget';
import { RateLimitConfigError } from './lib/rateLimiter';
import { CheckpointError, GRAPH_MUTATING_RUN_KINDS, VALIDATION_SCOPE_SEPARATOR, canonicalValidationRunKey, catalogInputIdentity, checkpointErrorFields, isRestrictedValidationRunKey, validationRunKeyInputPart, validationRunKeyNamesInput, withCatalogStageLock } from './lib/checkpoint';
import type { CatalogRunKind } from './lib/checkpoint';
import type { ScriptLogger } from './lib/logger';
// The publication floor for identity evidence, imported rather than restated:
// scripts/lib/catalogEvidence.ts is the one place the rule lives, so the import
// stage, validation, this exporter and catalog-load.ts cannot come to disagree
// about what a publishable retrieval record states. It is pure and reaches no
// client, no filesystem and no clock, so importing it costs this entry point
// nothing at module load.
//
// `COMPONENT_DERIVED_PROVENANCE` arrives from the same module and for the same
// reason: it is `deriveComponentNutrition`'s own output value, and the rule
// that a composition-bearing row must claim it is one this exporter, the
// validator and the loader all apply. A string literal here would be a fourth
// copy of the same statement.
import {
    COMPONENT_DERIVED_PROVENANCE,
    assessIdentityEvidence,
    assessSourceCacheBinding,
    cacheBindingGapCodes,
    cacheBindingRequired,
    describeCacheBindingGaps,
    describeEvidenceGaps,
    evidenceGapCodes,
    identityEvidenceSourceCacheKey,
} from './lib/catalogEvidence';
import type { EvidenceGapCode, SourceCacheRow } from './lib/catalogEvidence';
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
// This stage's policy is `development_or_test` — it mutates, so it runs only
// against a database whose own name says development or a `_test` one, and
// there is no confirmation door for it to open. The flag changes nothing here;
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

    /**
     * The reader for a switch that takes no value: the bare token turns it on
     * and there is no spelling that turns it off.
     *
     * An inline value is REFUSED rather than ignored. `--force=false` reads to
     * an operator as a request NOT to overwrite, and honouring it as the
     * opposite is how a reviewed, checksummed release directory that other
     * environments load gets replaced by a command line that asked for the
     * safe thing — so is `--force=0`, and so is a trailing `=`. There is no
     * value that could be accepted here either: reading `=true` would make the
     * grammar look like it has an off switch when `=false` is exactly what
     * cannot be honoured.
     *
     * A repeat is refused for the reason the release id's repeat is: a switch
     * written twice is not a command line the operator meant to write, and
     * this one authorizes a destructive overwrite. `alreadyGiven` is returned
     * unchanged on both refusals, so a rejected token never leaves the switch
     * enabled; the accumulated error makes the whole parse a refusal anyway.
     */
    const takeSwitch = (flag: string, inlineValue: string | null, alreadyGiven: boolean): boolean => {
        if (inlineValue !== null) {
            errors.push({
                flag,
                message: `${flag} takes no value, and ${flag}=false does not turn it off; omit ${flag} to leave it off`,
            });
            return alreadyGiven;
        }
        if (alreadyGiven) {
            errors.push({ flag, message: `${flag} was given more than once; it takes no value, so pass it once or not at all` });
            return alreadyGiven;
        }
        return true;
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
            force = takeSwitch(flag, inlineValue, force);
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
        '                   replaced. Takes no value: --force=false is refused rather',
        '                   than read as off — omit the flag to leave it off.',
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
 *
 * RESOLVED PHYSICALLY, NOT LEXICALLY, and that is the difference between a
 * path this stage can reason about and one it cannot. `path.resolve` collapses
 * `.` and `..` and nothing else, so a symbolic link ANYWHERE above the release
 * — `--out /srv/link-to-releases`, or a linked directory halfway up the
 * repository's own tree — survived into every later path operation: the
 * staging directory this stage creates is a sibling of this path, and
 * `assertSafeArtifactParent` reads the immediate parent with `lstat`, which
 * says nothing about an ancestor above it. `physicalPathIdentity` resolves
 * every link on the chain ONCE, here, so the directory that is created, the
 * parent that is held to the safe-parent rule, the staging directory whose
 * `(dev, ino)` is captured and the path the release is renamed into are all
 * spellings of one physical place.
 *
 * Resolving the chain does not freeze it — a link above the release can be
 * re-pointed after this call, which is why the parent assertion, the exclusive
 * create and the `(dev, ino)` re-checks in `runReleaseStage` and
 * `publishRelease` all exist. What it removes is the case where those three
 * guards are applied to a path whose ancestors were never resolved at all.
 *
 * THE RELEASE ID'S OWN COMPONENT IS LEFT AS IT WAS SPELLED in both branches.
 * Only the ancestors are resolved, because an entry AT the release id is
 * something this stage must DECIDE about rather than follow: publication
 * refuses it without `--force` and moves it aside under a `.superseded-` name
 * with it, which is what leaves an operator a link to look at. Resolving it
 * would instead publish straight through it, into whatever it points at.
 */
export const resolveReleaseDir = (outRoot: string | null): ((release: string) => string) =>
    outRoot === null
        ? (release: string): string => {
              // `releaseDir` validates the id and proves containment inside the
              // repository's data root; only its parent chain is resolved here.
              const canonical = releaseDir(release);
              return path.join(physicalPathIdentity(path.dirname(canonical)), path.basename(canonical));
          }
        : (release: string): string =>
              path.join(physicalPathIdentity(outRoot), assertSafePathSegment(release, 'release id'));

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
        if (isThrownInstanceOf(error, ManifestError)) {
            releaseValid = false;
            gaps.push({
                code: 'release_id_invalid',
                requirement: 'The --release value must be "v" followed by digits, and a single path segment',
                remedy: 'Pass a release id such as --release v1.',
                // Closed code only, never the sentence: a ManifestError message can carry
                // an absolute checkout path (manifest.ts `repo_root_not_found`) or a foreign
                // JSON parser message (`invalid_merged_report`), and `requirement` and
                // `remedy` beside it already carry everything an operator acts on.
                detail: error.code,
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
        if (isThrownInstanceOf(error, ManifestError)) {
            gaps.push({
                code: 'coverage_plan_unavailable',
                requirement:
                    'data/meal-planning/coverage-plan.v1.json must load and declare coveragePlanVersion v1: the release manifest records the plan version it was produced against and its per-category coverage',
                remedy: 'Add the 21-category coverage plan at data/meal-planning/coverage-plan.v1.json (AAP §0.7.1 Group 3).',
                // Closed code only, never the sentence: a ManifestError message can carry
                // an absolute checkout path (manifest.ts `repo_root_not_found`) or a foreign
                // JSON parser message (`invalid_merged_report`), and `requirement` and
                // `remedy` beside it already carry everything an operator acts on.
                detail: error.code,
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
        readonly component_catalog_foods: {
            readonly source_key: string;
            /** Whether the release carries this target at all — see the walk. */
            readonly publication_status: string;
        } | null;
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
    /**
     * The recorded USDA responses a published row's evidence digests were taken
     * over, read so the export can RESOLVE them instead of trusting their
     * shape (see THE SOURCE CACHE IS RESOLVED, NOT ASSUMED in the walk).
     *
     * Read-only, like every other member here except the ledger's `create`: a
     * release reads the cache and never writes it. It carries no `user_id`
     * either — `usda_api_cache` is a vendor response cache shared by the whole
     * installation, so the paragraph above applies to it unchanged.
     *
     * `findMany` rather than `findUnique` per row: one batch response evidences
     * up to twenty foods, so the keys of a page are looked up in chunks and a
     * payload is read once for every row citing it.
     */
    usda_api_cache: { findMany(args: unknown): Promise<SourceCacheRow[]> };
    catalog_import_runs: {
        create(args: unknown): Promise<{ id: string }>;
        /**
         * The release ledger row's outcome, written once publication has either
         * happened or failed — see `runReleaseStage`. A row that says
         * 'succeeded' before the rename is a row that can outlive the release
         * it describes.
         */
        update(args: unknown): Promise<{ id: string }>;
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
    /**
     * What the run RECORDED that it did. Read for validation rows only, and for
     * one question: did a pass that ran after the canonical one change any
     * food's publication status (`judged` minus `unchanged`)? Without it a
     * restricted pass is invisible to the readiness rules — see WHICH
     * VALIDATION ROW COUNTS.
     *
     * Optional because it is `Json?` in the schema and because a caller holding
     * older rows (a test, an older select) still satisfies the two rules that
     * do not read it.
     */
    readonly counts?: unknown;
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

/**
 * Which directory a path named, as the filesystem identifies one.
 *
 * A path is a name and names can be re-pointed; `(dev, ino)` is the directory
 * itself. The pair is what lets this stage state that the directory it is
 * about to publish is the one it exported into, rather than restating that the
 * same string is still spelled the same way — which a swapped symlink or a
 * replaced directory would also satisfy.
 */
export interface ReleaseDirectoryIdentity {
    readonly dev: number;
    readonly ino: number;
}

/**
 * Whether two readings name one directory.
 *
 * `null` never matches anything, including another `null`: an unreadable path
 * and an absent one are both "this is not the directory I identified", which is
 * the answer that makes a caller refuse rather than proceed on an unknown.
 */
export const sameDirectoryIdentity = (
    left: ReleaseDirectoryIdentity | null,
    right: ReleaseDirectoryIdentity | null,
): boolean => left !== null && right !== null && left.dev === right.dev && left.ino === right.ino;

/**
 * Every filesystem effect this stage has, in one injected place.
 *
 * The export's four file operations were already deps; publication's were not —
 * `fs.renameSync`, `fs.rmSync` and `process.pid` were reached for directly in
 * module scope and in `main()`, so the half of the stage that decides whether a
 * reviewed release is replaced was the half no test could drive (Rule
 * backend-architecture §4). They are all here now, which is what lets
 * `runReleaseStage` be exercised end to end — export, publication, ledger — on
 * in-memory doubles.
 */
export interface ReleaseFileSystem {
    readonly writeFile: (absolutePath: string, contents: string) => void;
    readonly readFileBytes: (absolutePath: string) => Buffer;
    readonly ensureDir: (absolutePath: string) => void;
    /**
     * Creates the LAST component of this path and nothing else at that name:
     * an entry already there, of any kind including a symbolic link, is a
     * refusal rather than a directory to adopt. The primitive the staging
     * directory is created with, and the reason a pre-placed name cannot
     * redirect a member write.
     */
    readonly createDirectoryExclusive: (absolutePath: string) => void;
    /**
     * The entry names directly inside this directory, in no promised order.
     * An absent directory is an empty listing rather than an error: the sweep
     * that reads it runs wherever a release is being cut, including the first
     * time that parent is used.
     */
    readonly listDirectoryNames: (absolutePath: string) => readonly string[];
    /**
     * The identity of the REAL DIRECTORY at this path, or `null` when the path
     * does not name one — a symbolic link (however it resolves), a file, or
     * nothing at all. Never follows the last component, so what it answers
     * about is the entry itself.
     */
    readonly directoryIdentity: (absolutePath: string) => ReleaseDirectoryIdentity | null;
    /**
     * Refuses unless the PARENT of this path is a real directory that no other
     * local principal can plant a name in. The rule itself is
     * lib/manifest.ts's `assertSafeArtifactParent`, so every publishing stage
     * holds its output to one definition of a safe parent.
     */
    readonly assertSafeParent: (absolutePath: string) => void;
    /** Recursive, and absent is not an error: it is what discards staging. */
    readonly removeDir: (absolutePath: string) => void;
    readonly directoryExists: (absolutePath: string) => boolean;
    readonly rename: (from: string, to: string) => void;
    /**
     * Creates the file with these contents ONLY if it does not exist, and
     * answers whether it did. The atomic claim publication serialises on; a
     * `exists ? no : create` pair could not do it, because two runs can both
     * observe "no".
     */
    readonly createFileExclusive: (absolutePath: string, contents: string) => boolean;
    /** Absent is not an error: it is what releases a lock that was never taken. */
    readonly removeFile: (absolutePath: string) => void;
    readonly openWriter?: (absolutePath: string) => ReleaseFileWriter;
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
     * Refuses unless `releaseDir`'s directory is still the same directory it
     * was when the caller identified it. Called by the export immediately
     * before EVERY path-based operation on a member — the `ensureDir`, each
     * member open, each read-back, and the manifest write — because a path is
     * re-resolved from its root on every one of them.
     *
     * WHY THE EXPORT CALLS THIS AT ALL, given that every member open is
     * already exclusive and `O_NOFOLLOW`. Those flags settle the member's LAST
     * component only. Everything above it — the staging directory itself — is
     * traversed by the kernel on each open, so a staging directory replaced by
     * a symbolic link while the export was awaiting the database or a page of
     * rows would send `path.join(directory, 'foods.jsonl')` through the
     * replacement, and the member bytes with it. Publication's own `(dev, ino)`
     * check would then refuse to publish, correctly — but the writes would
     * already have happened, which is the whole of what the staging TOCTOU
     * finding says must not be possible.
     *
     * Node exposes no descriptor-relative `openat`/`unlinkat`, so a member
     * cannot be opened RELATIVE to a directory handle this run holds: there is
     * no instrument here that removes the window between resolving a path and
     * using it. Re-validating the directory's identity immediately before each
     * path use is the available one, and it narrows that window from "the whole
     * export" — minutes, on a full catalog — to the interval between one
     * `lstat` and the syscall on the next line. The check is exact rather than
     * probabilistic about what it covers: any replacement that happened before
     * it is refused, and the residual is stated here rather than implied away.
     *
     * OPTIONAL, for the same reason `openWriter` is: the export can be driven
     * against a directory the caller named outright, with no staged identity to
     * compare — the prerequisite-pairing suites do exactly that — and there is
     * nothing for this seam to assert in that case. `runReleaseStage`, which is
     * the only caller that stages, always supplies it, so every release cut by
     * `main()` is guarded on every member operation.
     */
    readonly assertReleaseDirectoryUnchanged?: () => void;
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
 *
 * THE OPEN IS EXCLUSIVE AND DOES NOT FOLLOW A LINK. `openSync(path, 'w')`
 * follows a symbolic link at the member's own name and truncates whatever it
 * points at, so a link pre-placed inside the staging directory would send a
 * member — `manifest.json` included — anywhere the attacker chose, written with
 * this process's privileges. `openArtifactForWriteSync` is
 * `O_WRONLY|O_CREAT|O_EXCL` plus `O_NOFOLLOW`, which is the kernel's atomic
 * "create this name or fail". Exclusive rather than truncating is correct here
 * and not merely stricter: every member is created exactly once, inside a
 * directory this run created for it, so an existing name at that path is
 * someone else's doing.
 */
const descriptorWriter = (absolutePath: string): ReleaseFileWriter => {
    const handle = openArtifactForWriteSync(absolutePath);
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

/* ---------------------------------------------------------------------------
 * The identity evidence a release ships, measured while it is walked.
 *
 * WHY THE MANIFEST STATES THIS AT ALL. `validation-records.jsonl` is 56 MB of
 * JSONL for the committed release, so "does every published row carry a
 * retrieval record with an observed status" is a question no reviewer answers by
 * reading the artefact — and the one time nobody answered it, a release of
 * 11,046 rows whose mandatory `http_status` was null was frozen behind the
 * manifest's digests and shipped as accepted evidence. The block below is that
 * property written down: the published rows per identity source, the range of
 * statuses actually observed, and the histogram of the gaps the floor found.
 *
 * EVERY NUMBER IS MEASURED HERE OR IT IS NOT WRITTEN, exactly as
 * `model_versions` is (see `assertMeasuredModelVersions`): each one is counted
 * from the rows this walk emitted, never from the coverage plan, the previous
 * manifest or the row counts. The histogram is necessarily empty in a release
 * that exists, because the refusal below stops an export that found any gap —
 * which is the point: `gap_codes: []` is a measured statement that the floor
 * was applied and found nothing, and it is what catalog-load.ts cross-checks its
 * own streamed measurement against.
 * ------------------------------------------------------------------------- */

/** What the release carries for one `identity_source`, as the manifest states it. */
export interface ReleaseEvidenceIdentitySource {
    readonly identity_source: string;
    readonly published_foods: number;
    /** Published foods of this source whose validation record was assessed. */
    readonly assessed_records: number;
    /** The observed upstream statuses, or `null` when no record stated one. */
    readonly observed_status_min: number | null;
    readonly observed_status_max: number | null;
}

/**
 * The exporter's attestation that it RESOLVED the source cache behind every
 * published row that cites one.
 *
 * WHY THE MANIFEST HAS TO CARRY THIS AND NOT ONLY THE GAP HISTOGRAM. The
 * resolution is the one evidence check that cannot be re-made from the release:
 * `usda_api_cache` is a database table and no member carries it, so
 * `catalog-load.ts` can re-assess every record's SHAPE and nothing about
 * whether its digests stand for anything. This block is therefore the only
 * thing a reader — or the loader — has to go on, and it says how many rows
 * required resolution and how many were actually resolved, measured while the
 * rows were walked.
 *
 * `required_records` is a property of these bytes (published rows whose
 * identity source binds a cache key), so the loader re-measures it and refuses
 * a mismatch. `resolved_records` is not measurable from the release at all; it
 * is an attestation, and the loader can only check it covers what it measures.
 * Both are stated rather than one, because "10,928 of 10,928" and "10,928" are
 * different claims and only the first is falsifiable.
 */
export interface ReleaseSourceCacheResolution {
    /** Published rows whose identity source binds a `usda_api_cache` payload. */
    readonly required_records: number;
    /** Of those, the rows whose cache row was found and whose two digests recomputed equal. */
    readonly resolved_records: number;
    /** Distinct `usda_api_cache` rows the resolution read: one batch response evidences up to twenty foods. */
    readonly cache_rows_read: number;
}

/** The manifest's `evidence` block: the evidence floor's verdict over the release. */
export interface ReleaseEvidenceSummary {
    readonly published_foods: number;
    readonly assessed_records: number;
    readonly complete_records: number;
    readonly observed_status_min: number | null;
    readonly observed_status_max: number | null;
    /** Sorted by `identity_source`, so the bytes are reproducible. */
    readonly identity_sources: readonly ReleaseEvidenceIdentitySource[];
    /** Foods per gap code, sorted by code. Empty for a release that was cut. */
    readonly gap_codes: readonly { readonly code: EvidenceGapCode; readonly foods: number }[];
    /** What the export resolved against `usda_api_cache` — see the type's own contract. */
    readonly source_cache_resolution: ReleaseSourceCacheResolution;
}

/**
 * The manifest this stage writes.
 *
 * `CatalogReleaseManifest` in scripts/lib/manifest.ts is the shape every READER
 * is held to — the loader's preflight reads `files`, `counts` and the release
 * identity from it — and it is deliberately left untouched: the `evidence`
 * block is additive, a reviewed release cut before it existed must stay
 * loadable, and a reader that does not know the block simply does not read it.
 * Declared as an intersection here so the writer is type-checked against both
 * halves and every existing field stays byte-identical in shape.
 */
/**
 * Whether this release meets the catalog-size requirement, stated as a verdict
 * rather than left to be computed.
 *
 * WHY IT IS HERE AND NOT ONLY IN THE REPORTS. `coverage` already carries every
 * number a reader needs — the published total, the plan total, the aggregate
 * shortfall and the per-category gaps — and `validation-report.json` carries an
 * explicit `requirement.requirementMet`. But the manifest is the file that
 * TRAVELS WITH THE BYTES: an operator handed a release directory has this and
 * the five members, and nothing else. Leaving "does this meet the requirement"
 * as an arithmetic exercise over two totals is how a shortfall gets loaded and
 * enabled by someone who never opened the reports. So the export writes the
 * verdict down.
 *
 * IT IS A STATEMENT, NOT A GATE. The export still produces a release while the
 * requirement is unmet, deliberately: AAP §0.7.5 puts the fail-closed decision
 * at ENABLEMENT — the operator verifies `GET /catalog/status` shows the
 * required published count before setting `MEAL_PLANNING_ENABLED=true` — and
 * §0.7.3 makes the shortfall a reporting obligation on this stage rather than a
 * refusal. A release that cannot be cut also cannot be reviewed, loaded into a
 * development database, or benchmarked, and the evidence integrity this stage
 * does gate on would become unverifiable. What this block does is make the
 * unmet state impossible to miss at the point of use.
 */
export interface ReleaseAcceptanceVerdict {
    /**
     * Whether the release meets the catalog-size requirement: the published
     * total reaches `required_published_items`.
     *
     * ONE NAME, ONE QUESTION. This used to be the AND of that count and "no
     * category is below its own published target", which made the field answer
     * two requirements at once and disagree with the same name elsewhere in the
     * evidence: `catalog-report.ts` writes `requirement.requirementMet` from
     * the published count alone and states `everyCategoryMeetsItsTarget` beside
     * it. The two are genuinely different requirements — AAP §0.1.1 area 3
     * requires 10,000 published items, and §0.7.5's enablement step verifies
     * exactly that count, while the coverage plan's per-category targets total
     * 11,010 with deliberate slack over it (§0.7.3) so a per-category gap can
     * coexist with a met requirement. Collapsing them meant a release that
     * satisfied the feature's requirement could not say so, and a reader could
     * not tell which of the two conditions the `false` referred to.
     *
     * So the count is answered here, the per-category picture is answered by
     * `every_category_meets_its_target` and the exact per-category figures
     * beside it, and the statement states both. Neither is softened: a short
     * count still produces the shouted statement, and a per-category gap is
     * still named with its exact total in every case.
     */
    readonly requirement_met: boolean;
    readonly required_published_items: number;
    readonly published_items: number;
    readonly shortfall_against_requirement: number;
    readonly categories_below_target: number;
    readonly per_category_shortfall_total: number;
    /**
     * Whether every category of the coverage plan reaches its own
     * `publishedTarget` — the second, independent condition, read off the
     * per-category counts so it cannot disagree with them. A surplus in one
     * category never substitutes for a gap in another, which is why this is
     * stated rather than derived from the totals.
     */
    readonly every_category_meets_its_target: boolean;
    /** Plain prose for an operator reading only this file. */
    readonly statement: string;
}

/**
 * The published-item count AAP §0.1.1 requires of the catalog.
 *
 * Declared here rather than imported because `catalog-report.ts` holds its copy
 * as a private module constant, and this stage must not depend on that CLI to
 * write its own manifest. The two are the same number by the same requirement;
 * `validation-report.json` records it as `requirement.requiredPublishedItems`,
 * so a disagreement between the two artefacts is visible in the committed
 * evidence rather than hidden.
 */
const REQUIRED_PUBLISHED_ITEMS = 10000;

/** What the export measured about coverage, as the verdict needs it. */
export interface ReleaseAcceptanceInput {
    /** Published rows actually emitted into foods.jsonl. */
    readonly publishedItems: number;
    /** How many categories the coverage plan declares. */
    readonly categoryCount: number;
    /** How many of those are below their own published target. */
    readonly categoriesBelowTarget: number;
    /** The sum of those categories' shortfalls. */
    readonly perCategoryShortfallTotal: number;
}

/**
 * The acceptance requirement, answered.
 *
 * Pure, and exported so that every quadrant of the two independent conditions
 * is provable without an export of ten thousand rows: the published count can
 * be met or short, the per-category picture can be complete or short, and each
 * of the four combinations has its own reading. The two conditions are NOT
 * collapsed into one verdict (see ReleaseAcceptanceVerdict): the count is the
 * feature's requirement, the per-category targets are the coverage plan's own
 * and carry deliberate slack over it, and a reader has to be able to tell which
 * of the two a `false` refers to.
 *
 * The statement is where they meet, and it states whichever facts are true
 * without softening either: a short count is shouted, and a per-category gap is
 * named with its exact total even in a release whose count is met. A surplus in
 * one category never substitutes for a gap in another, so the per-category
 * sentence reports the sum of the gaps and never a netted figure.
 *
 * It states a verdict and refuses nothing — see ReleaseAcceptanceVerdict for
 * why that decision belongs at enablement rather than here.
 */
export const releaseAcceptanceVerdict = (input: ReleaseAcceptanceInput): ReleaseAcceptanceVerdict => {
    const shortfallAgainstRequirement = Math.max(0, REQUIRED_PUBLISHED_ITEMS - input.publishedItems);
    const requirementMet = shortfallAgainstRequirement === 0;
    const everyCategoryMeetsItsTarget = input.categoriesBelowTarget === 0;

    // The per-category half, in one sentence, appended to whichever verdict the
    // count produced. Written once rather than inlined into both branches: the
    // figures are the same facts either way, and two copies of one sentence is
    // how the two branches start disagreeing about how a gap is described.
    const categorySentence = everyCategoryMeetsItsTarget
        ? `All ${input.categoryCount} categories of the coverage plan meet their own published targets.`
        : `${input.categoriesBelowTarget} of ${input.categoryCount} categories are below their own published ` +
          `target by ${input.perCategoryShortfallTotal} items in total; the per-category gaps are in ` +
          'coverage.by_category, stated exactly and never netted against the categories that overshoot theirs.';

    return {
        requirement_met: requirementMet,
        required_published_items: REQUIRED_PUBLISHED_ITEMS,
        published_items: input.publishedItems,
        shortfall_against_requirement: shortfallAgainstRequirement,
        categories_below_target: input.categoriesBelowTarget,
        per_category_shortfall_total: input.perCategoryShortfallTotal,
        every_category_meets_its_target: everyCategoryMeetsItsTarget,
        statement: requirementMet
            ? `This release meets the catalog requirement: it publishes ${input.publishedItems} items against the ` +
              `required ${REQUIRED_PUBLISHED_ITEMS}, every one of them validated and carrying its own validation ` +
              `record. ${categorySentence}` +
              (everyCategoryMeetsItsTarget
                  ? ''
                  : ' The coverage plan\u2019s per-category targets total more than the requirement by design (AAP ' +
                    '§0.7.3), so a per-category gap is a coverage statement rather than a size one: it does not ' +
                    'put the required published count at risk, and AAP §0.7.5 verifies that count — not the ' +
                    'per-category targets — before the feature flag is enabled.')
            : 'THIS RELEASE DOES NOT MEET THE CATALOG REQUIREMENT. It publishes ' +
              `${input.publishedItems} items against the required ${REQUIRED_PUBLISHED_ITEMS} ` +
              `(${shortfallAgainstRequirement} short). ${categorySentence} It is exported so that it can be ` +
              'reviewed, loaded into a development database and benchmarked, and its evidence floor is enforced ' +
              'either way; it is not evidence that the catalog requirement is met, and the feature flag must not ' +
              'be enabled against it (AAP §0.7.5 verifies the published count before enablement).',
    };
};

export type CatalogReleaseManifestWithEvidence = CatalogReleaseManifest & {
    readonly evidence: ReleaseEvidenceSummary;
    readonly acceptance: ReleaseAcceptanceVerdict;
};

/**
 * The evidence facts of the walk, accumulated one published row at a time.
 *
 * Bounded by the number of distinct identity sources (two today) and gap codes
 * (eleven), never by the catalog: a release of 10,928 rows adds nothing to this
 * object beyond a few counters, which is what lets the measurement ride along
 * with the streamed export rather than needing a second pass over 59 MB.
 */
class EvidenceTally {
    private readonly bySource = new Map<
        string,
        { publishedFoods: number; assessedRecords: number; statusMin: number | null; statusMax: number | null }
    >();

    private readonly gapFoods = new Map<EvidenceGapCode, number>();

    private publishedFoods = 0;

    private assessedRecords = 0;

    private completeRecords = 0;

    /**
     * Counts one published row. `assessment` is `null` for a row whose
     * validation record is absent altogether — that row is refused by
     * `withoutValidationRecord`, and counting it here as a published food of its
     * source without an assessed record keeps the two numbers honest rather
     * than making the absent record look like a complete one.
     */
    public add(identitySource: string, assessment: ReturnType<typeof assessIdentityEvidence> | null): void {
        this.publishedFoods += 1;
        const source = this.bySource.get(identitySource) ?? {
            publishedFoods: 0,
            assessedRecords: 0,
            statusMin: null,
            statusMax: null,
        };
        source.publishedFoods += 1;

        if (assessment !== null) {
            this.assessedRecords += 1;
            source.assessedRecords += 1;
            if (assessment.complete) {
                this.completeRecords += 1;
            }
            if (assessment.status !== null) {
                source.statusMin = source.statusMin === null ? assessment.status : Math.min(source.statusMin, assessment.status);
                source.statusMax = source.statusMax === null ? assessment.status : Math.max(source.statusMax, assessment.status);
            }
            // One food counts once per distinct code, so the histogram reads as
            // "how many foods this gap held" rather than "how many fields".
            for (const code of evidenceGapCodes(assessment)) {
                this.gapFoods.set(code, (this.gapFoods.get(code) ?? 0) + 1);
            }
        }

        this.bySource.set(identitySource, source);
    }

    public summarise(): ReleaseEvidenceSummary {
        const identitySources = Array.from(this.bySource.entries())
            .sort((left, right) => (left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0))
            .map(([identitySource, measured]) => ({
                identity_source: identitySource,
                published_foods: measured.publishedFoods,
                assessed_records: measured.assessedRecords,
                observed_status_min: measured.statusMin,
                observed_status_max: measured.statusMax,
            }));

        const statuses = identitySources
            .flatMap((source) => [source.observed_status_min, source.observed_status_max])
            .filter((status): status is number => status !== null);

        return {
            published_foods: this.publishedFoods,
            assessed_records: this.assessedRecords,
            complete_records: this.completeRecords,
            observed_status_min: statuses.length === 0 ? null : Math.min(...statuses),
            observed_status_max: statuses.length === 0 ? null : Math.max(...statuses),
            identity_sources: identitySources,
            gap_codes: Array.from(this.gapFoods.entries())
                .sort((left, right) => (left[0] < right[0] ? -1 : 1))
                .map(([code, foods]) => ({ code, foods })),
            source_cache_resolution: {
                required_records: this.cacheRequired,
                resolved_records: this.cacheResolved,
                cache_rows_read: this.cacheRowsRead.size,
            },
        };
    }

    /** One published row whose identity source binds a `usda_api_cache` payload. */
    public addCacheRequired(): void {
        this.cacheRequired += 1;
    }

    /** One such row whose payload was found and whose two digests recomputed equal. */
    public addCacheResolved(cacheKey: string): void {
        this.cacheResolved += 1;
        this.cacheRowsRead.add(cacheKey);
    }

    private cacheRequired = 0;

    private cacheResolved = 0;

    /**
     * The distinct cache rows behind the resolved records. A set, because a
     * batch response evidences up to twenty foods and counting it once per food
     * would make the manifest overstate how many vendor exchanges the release
     * rests on. Bounded by the number of batches the import made (~471 for the
     * committed release), which is the one thing here that grows with the
     * catalog — a key string each, and the payloads themselves are never
     * retained.
     */
    private readonly cacheRowsRead = new Set<string>();
}

/** One row awaiting cache resolution, as the walk collected it. */
interface PendingCacheBinding {
    readonly sourceKey: string;
    readonly usdaFdcId: number | null;
    /** The evidence as the EMITTED line carries it — the bytes the manifest will bind. */
    readonly identityEvidence: unknown;
    readonly cacheKey: string | null;
}

/**
 * Distinct `usda_api_cache` keys per lookup.
 *
 * A payload is a whole `POST /foods` response — up to twenty full USDA records,
 * tens of kilobytes each — so this is the one query in the stage whose result
 * size is worth bounding explicitly: twenty keys is a few hundred records in
 * flight, read and dropped before the next chunk, while one key per query would
 * make ~471 round trips for the committed release and a whole page of keys at
 * once would hold megabytes of vendor JSON for no gain.
 */
const SOURCE_CACHE_LOOKUP_CHUNK = 20;

/**
 * Resolves one page's worth of pending cache bindings and records the outcome.
 *
 * WHAT IT READS AND WHY ONCE PER KEY. The rows of a page routinely share a
 * batch response — the import fetched twenty foods per call — so the keys are
 * de-duplicated first and every row citing a payload is assessed against the
 * one copy that was read. Nothing is retained after the chunk: the map is
 * scoped to it, so the peak is a chunk of payloads rather than a page of them.
 *
 * The assessment itself is not made here: {@link assessSourceCacheBinding} owns
 * the rule (the two digests, the status agreement and the record-belongs-to-
 * this-food test), under unit test, so this function is the I/O recipe around
 * it — which is the same division the evidence floor is applied under (Rule
 * backend-architecture §1.2/§7).
 */
const resolvePendingCacheBindings = async (
    tx: ReleaseDb,
    pending: readonly PendingCacheBinding[],
    sink: {
        readonly tally: EvidenceTally;
        readonly offenders: OffenderTally;
        readonly firstOffender: { sourceKey: string; detail: string }[];
    },
): Promise<void> => {
    if (pending.length === 0) {
        return;
    }

    const keys = Array.from(
        new Set(pending.map((entry) => entry.cacheKey).filter((key): key is string => key !== null)),
    );

    const rowsByKey = new Map<string, SourceCacheRow>();
    for (let index = 0; index < keys.length; index += SOURCE_CACHE_LOOKUP_CHUNK) {
        const chunk = keys.slice(index, index + SOURCE_CACHE_LOOKUP_CHUNK);
        const rows = await tx.usda_api_cache.findMany({
            where: { cache_key: { in: chunk } },
            select: { cache_key: true, payload: true, http_status: true },
        });
        for (const row of rows) {
            rowsByKey.set(row.cache_key, row);
        }
    }

    for (const entry of pending) {
        const assessment = assessSourceCacheBinding({
            identityEvidence: entry.identityEvidence,
            usdaFdcId: entry.usdaFdcId,
            cacheRow: entry.cacheKey === null ? null : rowsByKey.get(entry.cacheKey) ?? null,
        });

        if (assessment.resolved && assessment.cacheKey !== null) {
            sink.tally.addCacheResolved(assessment.cacheKey);
            continue;
        }

        sink.offenders.add(`${entry.sourceKey} (${cacheBindingGapCodes(assessment).join(', ')})`);
        if (sink.firstOffender.length === 0) {
            sink.firstOffender.push({
                sourceKey: entry.sourceKey,
                detail: `${entry.sourceKey}: ${describeCacheBindingGaps(assessment)}`,
            });
        }
    }
};

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
            // `publication_status` beside the key, because the key alone cannot
            // answer whether the release CARRIES that food: foods.jsonl holds
            // published rows only, so a component pointing at a candidate,
            // quarantined or retired food would name a key absent from it. See
            // A RELEASE'S COMPONENTS CLOSE OVER ITS OWN FOODS in the walk.
            component_catalog_foods: { select: { source_key: true, publication_status: true } },
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
/**
 * The one status a release exports.
 *
 * Named because two rules have to agree on it: the page query selects parents
 * by it, and the component-closure check asks whether a component's TARGET
 * carries it. Written twice, they could drift; read from here, the release's
 * membership rule and its closure rule are the same statement.
 */
const PUBLISHED_STATUS = 'published';

const releaseFoodPageQuery = (cursor: string | null, pageSize: number): unknown => ({
    where:
        cursor === null
            ? { publication_status: PUBLISHED_STATUS }
            : { publication_status: PUBLISHED_STATUS, source_key: { gt: cursor } },
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
    // A caller that staged this directory supplies the check; one that named
    // the directory outright has no identity to compare and supplies none. See
    // `assertReleaseDirectoryUnchanged` on RunReleaseDeps for why the export
    // asks before every path-based member operation rather than once.
    const assertDirectoryUnchanged = deps.assertReleaseDirectoryUnchanged ?? ((): void => undefined);

    const rowCounts: Record<string, number> = {
        'foods.jsonl': 0,
        'aliases.jsonl': 0,
        'portions.jsonl': 0,
        'components.jsonl': 0,
        'validation-records.jsonl': 0,
    };

    const withoutValidationRecord = new OffenderTally();
    /**
     * Published rows whose validation record does not meet the identity-evidence
     * floor — see the assessment in the walk. Each entry names the food and its
     * gap codes, because the repair differs per code: a null status needs the
     * retrieval made again, a missing digest needs the export that dropped it
     * re-cut.
     */
    const withoutCompleteIdentityEvidence = new OffenderTally();
    /**
     * The first offender's key and the field-by-field sentence for its gaps,
     * held as a one-entry list because the walk that fills it runs inside the
     * transaction callback and a narrowed `let` read back out here is not
     * something TypeScript's control-flow analysis can follow across that
     * boundary. The key is carried separately from the tally's decorated
     * entries so the refusal's `sourceKey` context is the food's own key, which
     * is what a programmatic caller looks the row up by.
     */
    const firstEvidenceOffender: { readonly sourceKey: string; readonly detail: string }[] = [];
    /**
     * The first component-bearing row whose provenance denies it, held as a
     * one-entry list for the same reason as `firstEvidenceOffender`: it is
     * filled inside the transaction callback, and the refusal's `sourceKey`
     * context has to be the food's own key rather than the tally's decorated
     * entry, because that is what a programmatic caller looks the row up by.
     */
    const firstComponentProvenanceOffender: string[] = [];
    /**
     * Published rows whose evidence digests could not be RESOLVED against the
     * `usda_api_cache` payload they cite — see THE SOURCE CACHE IS RESOLVED,
     * NOT ASSUMED in the walk. Decorated with the binding gap codes, because
     * the repair differs: an absent cache row needs the batch re-imported, a
     * digest that does not recompute means the record does not describe the
     * payload behind it.
     */
    const withoutResolvedSourceCache = new OffenderTally();
    /** The first such row's key and its field-by-field sentence, held for the same reason. */
    const firstCacheBindingOffender: { readonly sourceKey: string; readonly detail: string }[] = [];
    /**
     * The rows of the CURRENT page awaiting cache resolution, cleared at the end
     * of every page. Bounded by one page (250 rows) times four small fields,
     * never by the catalog, and it holds no payload: the payloads are fetched,
     * assessed and dropped inside `resolvePendingCacheBindings`.
     */
    const pendingCacheBindings: PendingCacheBinding[] = [];
    /** The evidence facts the manifest states, measured as the walk emits rows. */
    const evidenceTally = new EvidenceTally();
    const withoutUsableDefaultPortion = new OffenderTally();
    /** Compositions naming a food this release does not export — see the walk. */
    const componentTargetOutsideRelease = new OffenderTally();
    /**
     * Published rows that CARRY a composition while claiming their nutrition
     * came from somewhere else — see the refusal after the walk. Each entry
     * names the provenance claimed and how many component rows contradict it,
     * in the same decorated shape the evidence tally uses, because the repair
     * depends on which of the two the row got wrong.
     */
    const componentBearingWithoutDerivedProvenance = new OffenderTally();
    /** Published AI-generated foods with no batch to attribute them to. */
    const withoutGenerationBatch = new OffenderTally();
    /**
     * Every target `components.jsonl` actually names, deduplicated. Bounded by
     * the number of DISTINCT components in the release — the smallest member by
     * design — and used once, after the walk, to assert the emitted references
     * resolve against the foods the release carries.
     */
    const referencedComponentKeys = new Set<string>();
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
     * carries, read from their batches, and which model and prompt reviewed any
     * of them, read from their validation records' `llm_review`. Sets, because a
     * release spanning two generation or review runs carries two, and
     * `model_versions` must be measured from the rows rather than restated from
     * the plan — a plan states which environment variable SELECTS a model, which
     * is not evidence that a call was made.
     */
    const generationModels = new Set<string>();
    const generationPromptVersions = new Set<string>();
    const reviewModels = new Set<string>();
    const reviewPromptVersions = new Set<string>();
    let aiGeneratedFoods = 0;
    let reviewedFoods = 0;

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
    // (10,928 parents, whose validation records are 64 MB of JSON as JS
    // objects), every mapped line, and every joined member string, the largest
    // of which the join transiently doubles. Measured on the 9,422-row export
    // this release superseded, replacing the descriptor writers with the
    // buffering fallback cost ~59 MiB of peak RSS for the member strings
    // alone — the current export is larger still — with the
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

                // The first path use of the run, and the first of the awaited
                // window the ledger read above opened: the directory this is
                // about to write into is re-established as the one the caller
                // identified before `ensureDir` touches it, because
                // `mkdir -p` over a symbolic link to a directory succeeds
                // silently and would say nothing about what it adopted.
                assertDirectoryUnchanged();
                deps.ensureDir(directory);
                for (const fileName of RELEASE_DATA_FILES) {
                    // Per member, not once for the loop: each open resolves
                    // `directory` again from the root, so each one needs the
                    // directory to still be the identified one at the moment it
                    // runs. The exclusive no-follow open settles only
                    // `fileName` itself.
                    assertDirectoryUnchanged();
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

                        // PROVENANCE IS MEASURED HERE OR IT IS NOT MEASURED.
                        //
                        // Each of these four facts comes from the row itself:
                        // the batch that generated it names the model and prompt
                        // that produced it, and its validation record's
                        // `llm_review` names the model and prompt that reviewed
                        // it. Nothing is taken from the coverage plan, which
                        // says which env var SELECTS a model and is not evidence
                        // that a call happened.
                        if (row.identity_source === 'ai_generated') {
                            aiGeneratedFoods += 1;
                            if (row.catalog_generation_batches === null) {
                                // An AI-generated food with no batch cannot be
                                // attributed to a model at all, and the catalog
                                // policy requires an AI-generated record to be
                                // attributable. The old fallback filled the gap
                                // from configuration, which named a model that
                                // may never have run.
                                withoutGenerationBatch.add(row.source_key);
                            }
                        }
                        if (row.catalog_generation_batches !== null) {
                            generationModels.add(row.catalog_generation_batches.model);
                            generationPromptVersions.add(row.catalog_generation_batches.prompt_version);
                        }
                        const review = advisoryReviewProvenance(row.catalog_validation_records?.llm_review);
                        if (review !== null) {
                            reviewedFoods += 1;
                            if (review.model !== null) {
                                reviewModels.add(review.model);
                            }
                            if (review.promptVersion !== null) {
                                reviewPromptVersions.add(review.promptVersion);
                            }
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

                        // A RELEASE'S COMPONENTS CLOSE OVER ITS OWN FOODS.
                        //
                        // `components.jsonl` names its target by `source_key`
                        // because a local uuid means nothing in another
                        // database — and catalog-load.ts resolves that key
                        // against the release's own foods and the foods already
                        // loaded, refusing with `component_reference_unresolved`
                        // when neither carries it. So a target this release does
                        // not export is not a cosmetic gap: it is either a load
                        // that fails partway through a reviewed artefact, or —
                        // in a database that happens to hold a food under the
                        // same key — a composition whose meaning depends on the
                        // destination rather than on the release.
                        //
                        // Publication status is what decides membership, since
                        // foods.jsonl carries published rows and nothing else,
                        // and it is read from the SAME snapshot as the parents
                        // (see ONE SNAPSHOT, TWO READS) so the two cannot
                        // disagree. A non-published target is therefore not
                        // filtered away quietly the way a null one used to be:
                        // dropping it would leave an ingredient-derived food
                        // whose exported composition is a subset of the one its
                        // nutrient totals were computed from, which is a
                        // misstatement of where those totals came from. It is
                        // collected and the release is refused below.
                        const componentLines: Record<string, unknown>[] = [];
                        for (const component of row.catalog_food_components) {
                            const target = component.component_catalog_foods;
                            if (target === null) {
                                // Unreachable through the schema — the component
                                // FK is required and RESTRICT — and kept as a
                                // refusal rather than a filter for exactly that
                                // reason: if it ever happens, the composition
                                // has lost a component and the release must say
                                // so.
                                componentTargetOutsideRelease.add(`${row.source_key} → (unlinked component)`);
                                continue;
                            }
                            if (target.publication_status !== PUBLISHED_STATUS) {
                                componentTargetOutsideRelease.add(
                                    `${row.source_key} → ${target.source_key} (${target.publication_status})`,
                                );
                                continue;
                            }
                            referencedComponentKeys.add(target.source_key);
                            componentLines.push({
                                food_source_key: row.source_key,
                                // The portable reference, never the local uuid:
                                // a component id means nothing in another
                                // database. The key is spelled
                                // `component_food_source_key` because that is
                                // what catalog-load.ts reads, and the loader's
                                // reader is the release's format contract.
                                component_food_source_key: target.source_key,
                                quantity_grams: component.quantity_grams,
                                yield_factor: component.yield_factor,
                                component_nutrition_version: component.component_nutrition_version,
                                sort_order: component.sort_order,
                            });
                        }
                        componentLines.sort(byChildKey('component_food_source_key'));
                        for (const line of componentLines) {
                            emit('components.jsonl', line);
                        }

                        // A COMPOSITION IS NOT SOMETHING A ROW MAY CARRY WHILE
                        // DENYING IT.
                        //
                        // `deriveComponentNutrition` fixes the provenance of
                        // anything derived from a composition to
                        // `ingredient_derived` (src/services/catalog.logic.ts),
                        // so a published row that emits component lines while
                        // claiming `source_backed` or `ai_estimated` states two
                        // incompatible things about where its numbers came
                        // from: either the scalars are a source's statement and
                        // the composition is not theirs, or the composition is
                        // real and the provenance is wrong.
                        //
                        // WHY THE EXPORTER REFUSES IT AND NOT ONLY THE
                        // VALIDATOR. It is the same argument the evidence floor
                        // is exported with: validation judges the TABLE, and
                        // between the two a row can be relabelled out of band,
                        // restored by a `catalog:load` of an older release, or
                        // published by a build that predates the rule — while
                        // this walk is the last point at which the set being
                        // shipped is the set being examined. Left unchecked, a
                        // one-column edit produces a release whose parent
                        // scalars nothing compares with its own components:
                        // catalog-load.ts refuses exactly that
                        // (`release_component_inconsistent`,
                        // `parent_provenance_disagrees`), so a release carrying
                        // it is one no environment can load — a refusal an
                        // operator should get here, before the bytes are
                        // reviewed, and not after the release is published.
                        if (componentLines.length > 0 && row.nutrition_provenance !== COMPONENT_DERIVED_PROVENANCE) {
                            componentBearingWithoutDerivedProvenance.add(
                                `${row.source_key} (${row.nutrition_provenance}, ${componentLines.length} component row(s))`,
                            );
                            if (firstComponentProvenanceOffender.length === 0) {
                                firstComponentProvenanceOffender.push(row.source_key);
                            }
                        }

                        componentFacts.push({
                            source_key: row.source_key,
                            nutrition_provenance: row.nutrition_provenance,
                            // Only components the release CARRIES count: a row
                            // pointing at a food this release does not export is
                            // not something a nutrient total could have been
                            // derived from here, so it must not make a derived
                            // food look composed. The refusal below fires first
                            // in practice; this keeps the count honest either
                            // way.
                            resolvable_component_count: componentLines.length,
                        });

                        const validation = toReleaseValidationLine(row);
                        if (validation === null) {
                            withoutValidationRecord.add(row.source_key);
                            evidenceTally.add(row.identity_source, null);
                        } else {
                            emit('validation-records.jsonl', validation);

                            // THE EVIDENCE FLOOR, APPLIED TO THE SET BEING
                            // SHIPPED.
                            //
                            // The record is assessed against the fields a
                            // publishable retrieval record states (AAP §0.3.2;
                            // §0.7.3 classes missing identity evidence as a
                            // quarantine-tier hold), under the row's own
                            // identity source, because a USDA record must also
                            // name the cache key and the per-food digest that
                            // make one batch response evidence for THIS food.
                            //
                            // It is applied here because the exporter is the
                            // last point at which the set being shipped is the
                            // set being examined: after this walk the rows are
                            // bytes behind a digest, and a reader of the
                            // artefact can no longer ask the database anything.
                            // A published row whose record is incomplete is
                            // exactly what the import stage refuses to publish
                            // — `importPublicationStatus` derives its
                            // disposition from THIS predicate over the record
                            // it is about to write — so a release that carried
                            // one would ship rows the same pipeline declares
                            // ineligible, and the manifest's digests would then
                            // bind them as accepted evidence.
                            //
                            // Read off the LINE that was just emitted rather
                            // than off the Prisma row: those are the bytes the
                            // manifest's digest will bind and the loader will
                            // read, so assessing anything else would be
                            // checking a value the release does not carry.
                            const assessment = assessIdentityEvidence(validation.identity_evidence, {
                                identitySource: row.identity_source,
                            });
                            evidenceTally.add(row.identity_source, assessment);
                            if (!assessment.complete) {
                                withoutCompleteIdentityEvidence.add(
                                    `${row.source_key} (${evidenceGapCodes(assessment).join(', ')})`,
                                );
                                if (firstEvidenceOffender.length === 0) {
                                    // The full field-by-field sentence for ONE
                                    // offender, so the refusal says which field
                                    // of which record is missing and what it
                                    // must carry. Naming every offender that
                                    // way would put 56 MB of prose in an error.
                                    firstEvidenceOffender.push({
                                        sourceKey: row.source_key,
                                        detail: `${row.source_key}: ${describeEvidenceGaps(assessment)}`,
                                    });
                                }
                            }

                            // THE SOURCE CACHE IS RESOLVED, NOT ASSUMED.
                            //
                            // The floor above checks that a USDA record STATES
                            // a cache key and two 64-hex digests. That is a
                            // statement about the record's shape, and a record
                            // can satisfy it while standing for nothing: a key
                            // no `usda_api_cache` row answers to, or sixty-four
                            // hex characters that are not the digest of any
                            // payload, ships exactly as cleanly as a real one.
                            // The reason those fields are stored at all is that
                            // a reader can look the payload up and recompute —
                            // so this export does it, over every published USDA
                            // row, while the cache is still reachable. After
                            // this walk nothing can: `usda_api_cache` is a
                            // table, no release member carries it, and
                            // catalog-load.ts therefore has no way to perform
                            // this check at all (see the manifest's
                            // `source_cache_resolution`, which is what the
                            // loader is left to enforce).
                            //
                            // Deferred to the end of the PAGE rather than done
                            // per row: one batch response evidences up to
                            // twenty foods, so the keys are looked up in chunks
                            // and each payload is read once for every row
                            // citing it.
                            //
                            // Skipped for a row whose structural assessment
                            // already failed: it has been recorded above and
                            // the export is refused for it either way, and
                            // resolving a record with no cache key would add a
                            // second description of one defect.
                            if (cacheBindingRequired(row.identity_source) && assessment.complete) {
                                evidenceTally.addCacheRequired();
                                pendingCacheBindings.push({
                                    sourceKey: row.source_key,
                                    usdaFdcId: row.usda_fdc_id,
                                    identityEvidence: validation.identity_evidence,
                                    // Read through the shared reader, so the key
                                    // this looks up is the key the assessment
                                    // will read out of the same record.
                                    cacheKey: identityEvidenceSourceCacheKey(validation.identity_evidence),
                                });
                            }
                        }
                    }

                    // The page's cache bindings, resolved before the next page
                    // is read so the payloads of one page are released before
                    // the payloads of the next are fetched.
                    await resolvePendingCacheBindings(tx, pendingCacheBindings, {
                        tally: evidenceTally,
                        offenders: withoutResolvedSourceCache,
                        firstOffender: firstCacheBindingOffender,
                    });
                    pendingCacheBindings.length = 0;

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

    // AND THE RECORD IT CARRIES HAS TO BE EVIDENCE.
    //
    // A record that exists but states no observed status, no body digest or —
    // for a USDA row — no cache key and no per-food digest is not evidence of
    // the food: nobody can re-fetch the bytes it claims, and nothing ties one
    // batch response to this row rather than to the twenty it carried. The
    // import stage already refuses to PUBLISH such a row
    // (`importPublicationStatus` quarantines a retrieval that carried no
    // observed status, AAP §0.3.2; §0.7.3 makes missing identity evidence a
    // quarantine-tier hold), so a release carrying one ships rows the same
    // pipeline declares ineligible — and freezes them behind the manifest's
    // digests as the accepted evidence, which is how 11,046 rows with a null
    // `http_status` came to be a reviewed artefact.
    //
    // WHY THE EXPORTER AND NOT ONLY THE VALIDATOR. The validator judges the
    // TABLE; this stage decides what leaves it. Between the two, a row can be
    // published by a stage that predates the floor, restored by a `catalog:load`
    // of an older release, or edited out of band — and the export is the last
    // point at which the set being shipped is the set being examined. The
    // refusal is raised here, after the walk, for the same reason the other
    // post-walk refusals are: every byte written so far is in a staging
    // directory main() deletes rather than promotes, so nothing reaches the
    // reviewed path.
    //
    // The floor itself is not restated here: `assessIdentityEvidence` in
    // scripts/lib/catalogEvidence.ts is the single rule, under unit test, that
    // the import stage, validation and the loader all apply (Rule
    // backend-architecture §1.2/§7 — a rule someone could get wrong lives in a
    // pure module, not in the script that reports it).
    if (withoutCompleteIdentityEvidence.total > 0) {
        throw new ReleaseIntegrityError(
            `${withoutCompleteIdentityEvidence.total} published food(s) carry a validation record whose identity evidence is incomplete, so the release would ship published rows the import stage refuses to publish: ${withoutCompleteIdentityEvidence.describe()}. First gap: ${
                firstEvidenceOffender.length === 0 ? 'none recorded' : firstEvidenceOffender[0].detail
            }. A retrieval record's fields are observed, never reconstructed — re-run "npm run catalog:import" (a USDA row) or "npm run catalog:generate" (a generated one) so the retrieval is made again, then "npm run catalog:validate", and cut the release from the result. Filling a status or a digest by hand would fabricate the evidence this floor exists to keep out of a published row.`,
            {
                file: 'validation-records.jsonl',
                sourceKey: firstEvidenceOffender.length === 0 ? undefined : firstEvidenceOffender[0].sourceKey,
            },
        );
    }

    // AND THE DIGESTS IT CARRIES HAVE TO STAND FOR SOMETHING.
    //
    // The refusal above is about the record's SHAPE; this one is about whether
    // that shape resolves. A `source_cache_key` no `usda_api_cache` row answers
    // to, a `body_sha256` that is not the digest of the payload behind it, a
    // `record_sha256` that is some other food's record, or a status the cache
    // row contradicts — each of those is a record that looks like evidence and
    // cannot be re-derived by anyone, which is the whole reason the key and the
    // digests are stored next to each other. This is the last stage that can
    // tell the difference: `usda_api_cache` is a table, no release member
    // carries it, and catalog-load.ts can only re-check the shape (it enforces
    // the manifest's `source_cache_resolution` instead, and says so).
    //
    // The remedy is the import, not an edit: a digest is recomputed from a
    // payload or it is nothing, and writing one by hand would fabricate exactly
    // the evidence this gate exists to keep out of a reviewed release.
    if (withoutResolvedSourceCache.total > 0) {
        throw new ReleaseIntegrityError(
            `${withoutResolvedSourceCache.total} published food(s) carry identity evidence whose digests do not resolve against the usda_api_cache payload they cite, so the release would ship evidence nobody can re-derive: ${withoutResolvedSourceCache.describe()}. First gap: ${
                firstCacheBindingOffender.length === 0 ? 'none recorded' : firstCacheBindingOffender[0].detail
            }. The cache key and the two digests are recomputed from the recorded response (sha256 of its key-sorted JSON, and of this food's own record inside it): re-run "npm run catalog:import" for those rows so the retrieval and its digests are written together, then "npm run catalog:validate", and cut the release from the result. Filling a digest by hand would fabricate the evidence this floor exists to keep out of a published row.`,
            {
                file: 'validation-records.jsonl',
                sourceKey:
                    firstCacheBindingOffender.length === 0 ? undefined : firstCacheBindingOffender[0].sourceKey,
            },
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

    // THE RELEASE IS A CLOSED GRAPH, OR IT IS NOT A RELEASE.
    //
    // Refused before the emptiness rule below, because this is the more
    // specific cause: a derived food whose components all point outside the
    // published set would otherwise be reported as "carries no component rows",
    // which is true of the artefact and says nothing about why.
    if (componentTargetOutsideRelease.total > 0) {
        throw new ReleaseIntegrityError(
            `${componentTargetOutsideRelease.total} composition row(s) name a food this release does not carry, so components.jsonl would reference keys absent from foods.jsonl and catalog:load would refuse the release with component_reference_unresolved: ${componentTargetOutsideRelease.describe()}. Publish those foods, or remove the composition, before cutting a release.`,
            { file: 'components.jsonl', sourceKey: componentTargetOutsideRelease.first },
        );
    }

    // AND EVERY REFERENCE ACTUALLY EMITTED RESOLVES.
    //
    // The filter above already admits published targets only, and the parents
    // were selected on that same status inside one snapshot, so this set is a
    // subset of the exported keys by construction — which is precisely why it
    // is worth asserting: the claim the loader depends on is cheap to state
    // here, and a future change to either the page query or the component
    // filter that broke it would otherwise be invisible until a load failed.
    // The exported keys are read back off `componentFacts`, which the walk has
    // already retained one entry per food for, so no second index of the
    // catalog is built to check it.
    const exportedFoodKeys = new Set(componentFacts.map((fact) => fact.source_key));
    const unresolvedComponentKeys = Array.from(referencedComponentKeys)
        .filter((sourceKey) => !exportedFoodKeys.has(sourceKey))
        .sort();
    if (unresolvedComponentKeys.length > 0) {
        throw new ReleaseIntegrityError(
            `components.jsonl names ${unresolvedComponentKeys.length} food source key(s) that foods.jsonl does not carry, so the release is not a self-contained graph: ${unresolvedComponentKeys
                .slice(0, NAMED_OFFENDERS)
                .join(', ')}${unresolvedComponentKeys.length > NAMED_OFFENDERS ? ', …' : ''}.`,
            { file: 'components.jsonl', sourceKey: unresolvedComponentKeys[0] },
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
    // AND THE DUAL OF THAT RULE: A COMPOSITION WHOSE PARENT DENIES DERIVING
    // FROM IT.
    //
    // `assessComponentCoverage` above answers "does every published
    // `ingredient_derived` food have a composition". This answers the other
    // direction — "does every published composition belong to a food that says
    // its numbers came from one" — and the two together are what make the
    // member's contents meaningful in both directions. Collected during the
    // walk (see the emission site for why the exporter is the right place to
    // refuse it) and raised here, after it, for the same reason as the other
    // post-walk refusals: every byte written so far is in a staging directory
    // main() deletes rather than promotes.
    //
    // Refused in the same shape as the evidence gap it is a sibling of: the
    // count, the named offenders with what each one claims, one offender's own
    // key on the error's context, and the operator's next command. The repair
    // is a re-derivation or a corrected composition — never an edit to
    // `foods.jsonl`, because a parent's nutrition moving has to move its
    // `nutrition_version` and therefore invalidate the recipe snapshots citing
    // it.
    if (componentBearingWithoutDerivedProvenance.total > 0) {
        throw new ReleaseIntegrityError(
            `${componentBearingWithoutDerivedProvenance.total} published food(s) carry component rows while declaring a nutrition_provenance other than '${COMPONENT_DERIVED_PROVENANCE}', so the release would state two incompatible things about where their nutrition came from and catalog:load would refuse it with release_component_inconsistent (parent_provenance_disagrees): ${componentBearingWithoutDerivedProvenance.describe()}. A composition's totals are the output of deriveComponentNutrition, which calls them '${COMPONENT_DERIVED_PROVENANCE}': re-derive those foods with "npm run catalog:validate", or remove the composition from a food whose numbers really are its source's statement, before cutting a release. Editing foods.jsonl is not the repair — a parent's nutrition moving has to move its nutrition_version.`,
            { file: 'components.jsonl', sourceKey: firstComponentProvenanceOffender[0] },
        );
    }

    logger.info('components_asserted', {
        components: rowCounts['components.jsonl'],
        published_ingredient_derived: componentCoverage.derivedCount,
    });

    // AN AI-GENERATED ROW THIS RELEASE CANNOT ATTRIBUTE IS NOT SHIPPED.
    //
    // The generation batch is the only record of which model and prompt produced
    // a generated food, so a published `ai_generated` row without one leaves the
    // manifest with nothing truthful to say about it. The previous behaviour
    // filled that silence from the coverage plan — a model name read from
    // configuration, for a call nobody can show happened — which is exactly the
    // fabricated provenance the feature's nutrition-integrity requirement rules
    // out. Refused instead, naming the rows, because the repair is to record the
    // batch (or to unpublish the row), not to guess.
    if (withoutGenerationBatch.total > 0) {
        throw new ReleaseIntegrityError(
            `${withoutGenerationBatch.total} published AI-generated food(s) carry no generation batch, so the release cannot attribute the model and prompt that produced them: ${withoutGenerationBatch.describe()}. Re-run catalog:generate for those rows, or unpublish them, before cutting a release.`,
            { file: 'foods.jsonl', sourceKey: withoutGenerationBatch.first },
        );
    }

    const modelVersions = modelVersionsFor({
        aiGeneratedFoods,
        reviewedFoods,
        generationModels,
        generationPromptVersions,
        reviewModels,
        reviewPromptVersions,
    });
    assertMeasuredModelVersions(modelVersions);
    // The COMPLETE sets, logged as well as written, so a release produced across
    // more than one model or prompt states that fact in the run's output too —
    // the singular manifest fields are null in that case by design, and a
    // reader of the log should not have to open the manifest to see why.
    logger.info('release_model_provenance_measured', {
        stage: STAGE,
        aiGeneratedFoods,
        reviewedFoods,
        generationModels: sortedValues(generationModels).join(', '),
        generationPromptVersions: sortedValues(generationPromptVersions).join(', '),
        reviewModels: sortedValues(reviewModels).join(', '),
        reviewPromptVersions: sortedValues(reviewPromptVersions).join(', '),
    });

    // The evidence verdict, measured over the rows this walk emitted and logged
    // beside the manifest it is written into. Every published row has been
    // assessed by now and the refusal above has already fired for any gap, so
    // this line is the run's own statement that the floor was applied: a reader
    // sees the assessed count, the status range and an empty gap histogram
    // without opening a 56 MB member.
    const evidence = evidenceTally.summarise();
    assertMeasuredEvidence(evidence);
    logger.info('release_evidence_measured', {
        stage: STAGE,
        publishedFoods: evidence.published_foods,
        assessedRecords: evidence.assessed_records,
        completeRecords: evidence.complete_records,
        observedStatusMin: evidence.observed_status_min,
        observedStatusMax: evidence.observed_status_max,
        identitySources: evidence.identity_sources
            .map((source) => `${source.identity_source}=${source.published_foods}`)
            .join(', '),
        gapCodes: evidence.gap_codes.map((gap) => `${gap.code}=${gap.foods}`).join(', '),
        // The resolution the loader cannot re-make, in the run's own output as
        // well as in the manifest: an operator reading the log sees how many
        // rows were bound to a cached payload and how many vendor exchanges
        // those bindings rest on, without opening the artefact.
        cacheBindingsRequired: evidence.source_cache_resolution.required_records,
        cacheBindingsResolved: evidence.source_cache_resolution.resolved_records,
        cacheRowsRead: evidence.source_cache_resolution.cache_rows_read,
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
        // The read-backs are path uses too, and they are the ones the manifest
        // is MEASURED from: a directory swapped between the last member write
        // and this read would have the manifest describe six files this
        // pipeline never wrote, which is precisely the artefact a digest check
        // afterwards cannot distinguish from a real release.
        assertDirectoryUnchanged();
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
    // 10,928 foods against a plan total of 11,010, and 13 categories sit below
    // their own targets while 8 others overshoot theirs.
    // Reporting 0 there would claim per-category coverage this release does
    // not have, which is the one thing the header forbids. The aggregate
    // comparison is still reported, under its own name, so neither fact is
    // lost.
    const shortfallTotal = coverageShortfall.shortfallTotal;
    const publishedGapToTotal = Math.max(0, coveragePlan.publishedTargetTotal - foodCount);

    // THE ACCEPTANCE VERDICT (see ReleaseAcceptanceVerdict for why it is stated
    // here and why it is not a refusal). Two independent conditions, each
    // answered on its own field: a release can reach the required published
    // count while a category is still short of its own target, because a
    // surplus elsewhere cannot substitute for it — and the verdict says so
    // rather than collapsing the two into one boolean a reader cannot decode.
    //
    // Measured against `foodCount` — the rows actually emitted into
    // foods.jsonl — and not against the shortfall verdict's `publishedTotal`,
    // which deliberately excludes any category the plan does not declare. The
    // requirement is a statement about the published catalog, so a row must not
    // drop out of it for having an unplanned category. The refusal on
    // `unknownCategories` above means the two numbers are in fact equal in any
    // release that is cut, so this choice cannot silently disagree with
    // coverage.published_total; it is written this way so that it reads as the
    // same measurement catalog-report.ts calls `publishedItems`.
    const acceptance = releaseAcceptanceVerdict({
        publishedItems: foodCount,
        categoryCount: coverageShortfall.categories.length,
        categoriesBelowTarget: coverageShortfall.categories.filter((category) => category.shortfall > 0).length,
        perCategoryShortfallTotal: shortfallTotal,
    });

    const manifest: CatalogReleaseManifestWithEvidence = {
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
        // Derived above from the exported rows alone — the batches that produced
        // the AI-generated foods and the `llm_review` records their validation
        // records carry — and asserted to be strings before it is written. A
        // release built entirely from sourced USDA records made no model call,
        // so every singular field is null and every set empty, and that null is
        // a measurement of the rows rather than a default: naming a model a
        // release did not use would misattribute every food in it, and naming
        // none for a release that did use one would hide the attribution the
        // catalog policy requires. Several values make the singular field null
        // and are stated in full in the set beside it; the coverage plan is not
        // consulted at all, because it declares which environment variable
        // selects a model and not that a call was ever made.
        model_versions: modelVersions,
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
        // THE ACCEPTANCE REQUIREMENT, ANSWERED RATHER THAN LEFT TO BE COMPUTED.
        //
        // Every number here is derivable from the `coverage` block above, which
        // is exactly why it is written: a consumer that has to compare
        // published_actual_total against a threshold it holds privately, and
        // scan by_category for positive shortfalls, is a consumer that can
        // reach the wrong verdict quietly. Stated once, by the stage that
        // measured the rows, it travels with the bytes the manifest's digests
        // bind.
        acceptance,
        // THE EVIDENCE FLOOR'S VERDICT, WRITTEN DOWN.
        //
        // Measured while the rows were walked (see EvidenceTally): the published
        // rows per identity source, the range of statuses those retrievals
        // actually returned, and the histogram of the gaps the floor found —
        // which is empty in any release that was cut, because the refusal above
        // fires on the first gap. That empty list is the statement a reviewer
        // cannot otherwise make without reading 56 MB of JSONL, and
        // catalog-load.ts cross-checks it against its own streamed measurement
        // of the same members, so a hand-edited block is caught before a row is
        // written.
        //
        // Deterministic by construction: sorted keys, integer counts, and no
        // wall-clock value beyond `generated_at` above. Nothing here is read
        // from the coverage plan or from a previous manifest.
        evidence,
    };

    // The last member written and the one that turns five files into a release,
    // so it is held to the same check as the five: a manifest written through a
    // replaced directory would be a complete, self-consistent release document
    // sitting somewhere nobody asked for.
    assertDirectoryUnchanged();
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

    // THIS FUNCTION WRITES NO ROW AT ALL.
    //
    // The export is read-only over the catalog graph: not one
    // catalog_foods / catalog_food_aliases / catalog_food_portions /
    // catalog_food_components / catalog_validation_records row is inserted,
    // updated or deleted anywhere in this file, which is what makes cutting a
    // release a safe thing to do twice.
    //
    // The pipeline run LEDGER row — kind 'release', which
    // prisma/schema.prisma:340 documents for exactly this stage — belongs to
    // `runReleaseStage`, which opens it BEFORE the export and closes it
    // 'succeeded' only after the staging directory has been moved into its
    // reviewed path. It used to be written here, as 'succeeded', while the
    // rename was still ahead: a failed rename then left a ledger claiming a
    // release that was not at its path, and a failed export left no row at all.
    // A row's status is a statement about a published artefact, so it is the
    // orchestrator — the one function that knows whether publication happened —
    // that makes it.
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
 * The model and prompt an advisory review recorded on a validation record, or
 * `null` when no review is recorded there.
 *
 * `catalog_validation_records.llm_review` is written by catalog-validate's
 * `advisoryReviewRecord` (and by `failedAdvisoryReviewRecord` for a review that
 * was attempted and did not answer), both of which carry `model` and
 * `prompt_version`. A failed review counts as a review that RAN — the call was
 * made and it is attributable — which is what this field documents; whether it
 * lifted anything is the record's own business and never the release's.
 *
 * Read defensively rather than cast, because this column is JSON written by
 * another stage and possibly by an older version of it: an object that carries
 * neither string is still a review record (the row is not null), and it
 * contributes to `reviewed_foods` without inventing a model name.
 */
const advisoryReviewProvenance = (
    llmReview: unknown,
): { readonly model: string | null; readonly promptVersion: string | null } | null => {
    if (llmReview === null || llmReview === undefined || typeof llmReview !== 'object' || Array.isArray(llmReview)) {
        return null;
    }
    const record = llmReview as { readonly model?: unknown; readonly prompt_version?: unknown };
    return {
        model: typeof record.model === 'string' && record.model.length > 0 ? record.model : null,
        promptVersion:
            typeof record.prompt_version === 'string' && record.prompt_version.length > 0
                ? record.prompt_version
                : null,
    };
};

/** A measured set as the manifest states it: sorted by code point, so the bytes are reproducible. */
const sortedValues = (values: ReadonlySet<string>): readonly string[] => Array.from(values).sort();

/**
 * The singular `model_versions` field for a measured set: the value when the
 * release carries exactly ONE, and `null` otherwise.
 *
 * `null` for several is the point, and it replaces taking the greatest. A
 * release produced across two models has no single model, and naming the later
 * of the two attributed every row in it to a model some of them did not come
 * from — a misstatement a reader of the manifest could not detect. The complete
 * set is written beside this field, so nothing is discarded by declining to
 * collapse it.
 */
const onlyValue = (values: readonly string[]): string | null => (values.length === 1 ? values[0] : null);

/**
 * `model_versions`, measured from the published rows this release carries and
 * from nothing else.
 *
 * Every field is derived from the rows: the generation model and prompt from
 * the batches that produced the AI-generated foods, the review model and prompt
 * from the `llm_review` records those foods' validation records carry. A release
 * built entirely from sourced USDA records has empty sets, and therefore nulls
 * and empty arrays — and that null is a MEASUREMENT of the rows rather than a
 * default: naming a model a release did not use would misattribute every food
 * in it, and the coverage plan cannot supply one, because it declares which
 * environment variable selects a model and not that a call was ever made.
 */
const modelVersionsFor = (input: {
    readonly aiGeneratedFoods: number;
    readonly reviewedFoods: number;
    readonly generationModels: ReadonlySet<string>;
    readonly generationPromptVersions: ReadonlySet<string>;
    readonly reviewModels: ReadonlySet<string>;
    readonly reviewPromptVersions: ReadonlySet<string>;
}): CatalogReleaseModelVersions => {
    const generationModels = sortedValues(input.generationModels);
    const generationPromptVersions = sortedValues(input.generationPromptVersions);
    const reviewModels = sortedValues(input.reviewModels);
    const reviewPromptVersions = sortedValues(input.reviewPromptVersions);
    const generationPromptVersion = onlyValue(generationPromptVersions);

    return {
        generation_model: onlyValue(generationModels),
        review_model: onlyValue(reviewModels),
        prompt_version: generationPromptVersion,
        // `prompt_version` under the release format contract's spelling, which
        // names it for the generation prompt it records and pairs it with the
        // review prompt beside it.
        generation_prompt_version: generationPromptVersion,
        review_prompt_version: onlyValue(reviewPromptVersions),
        generation_models: generationModels,
        review_models: reviewModels,
        generation_prompt_versions: generationPromptVersions,
        review_prompt_versions: reviewPromptVersions,
        ai_generated_foods: input.aiGeneratedFoods,
        reviewed_foods: input.reviewedFoods,
    };
};

/**
 * Refuses an `evidence` block whose own parts disagree.
 *
 * The counterpart of `assertMeasuredModelVersions`, and there for the same
 * reason: a manifest is EVIDENCE, so the last thing done before writing one is
 * to assert that what it states about itself holds. Every number here is a
 * counter incremented while the walk emitted rows, which is exactly why the
 * check is worth making — a future change to where a row is counted would
 * otherwise write a block that reads plausibly and describes a set nobody
 * measured. Three invariants cover it: the per-source counts sum to the totals,
 * a release that was cut has an assessed record per published row and no gap,
 * and every observed status sits in the successful range the floor requires.
 *
 * It is a refusal rather than a log line because the block's only purpose is to
 * let a reviewer trust it without streaming 56 MB of records.
 */
const assertMeasuredEvidence = (evidence: ReleaseEvidenceSummary): void => {
    const refuse = (problem: string): never => {
        throw new ReleaseIntegrityError(
            `the manifest's evidence block would state ${problem}, so it is not a measurement of the rows this ` +
                `release carries: ${JSON.stringify(evidence)}. Every number in that block is counted while the ` +
                'published rows are walked; a release is not cut from one that cannot be reconciled with itself.',
            { file: RELEASE_MANIFEST_FILE_NAME },
        );
    };

    const summed = evidence.identity_sources.reduce(
        (totals, source) => ({
            published: totals.published + source.published_foods,
            assessed: totals.assessed + source.assessed_records,
        }),
        { published: 0, assessed: 0 },
    );
    if (summed.published !== evidence.published_foods || summed.assessed !== evidence.assessed_records) {
        refuse(
            `per-identity-source counts (${summed.published} published, ${summed.assessed} assessed) that do not sum to its own totals (${evidence.published_foods} published, ${evidence.assessed_records} assessed)`,
        );
    }
    // Reached only after the refusals above have cleared, so every published row
    // has a record and every record is complete; a block saying otherwise would
    // contradict the release's own existence.
    if (evidence.assessed_records !== evidence.published_foods) {
        refuse(
            `${evidence.assessed_records} assessed record(s) for ${evidence.published_foods} published food(s), although a release carries one record per published food`,
        );
    }
    if (evidence.complete_records !== evidence.assessed_records || evidence.gap_codes.length > 0) {
        refuse(
            `${evidence.assessed_records - evidence.complete_records} incomplete record(s) and ${evidence.gap_codes.length} gap code(s), although a release is only cut when every published row's evidence is complete`,
        );
    }
    for (const status of [evidence.observed_status_min, evidence.observed_status_max]) {
        if (status !== null && (!Number.isInteger(status) || status < 200 || status > 299)) {
            refuse(`an observed HTTP status of ${String(status)}, which is outside the successful range`);
        }
    }
    if (evidence.published_foods > 0 && (evidence.observed_status_min === null || evidence.observed_status_max === null)) {
        refuse('no observed status range at all, although every published row it counted carries an observed status');
    }

    // THE ATTESTATION IS THE ONE THE LOADER CANNOT RE-MAKE, so it is the one
    // most worth asserting before it is written. Reached only after the
    // resolution refusal has cleared, which means every row that required
    // resolution got it — a block saying otherwise would be a manifest
    // contradicting the release's own existence, and it is what
    // catalog-load.ts refuses a release on.
    const resolution = evidence.source_cache_resolution;
    for (const [field, value] of Object.entries(resolution)) {
        if (!Number.isInteger(value) || value < 0) {
            refuse(`a source_cache_resolution.${field} of ${String(value)}, which is not a count`);
        }
    }
    if (resolution.resolved_records !== resolution.required_records) {
        refuse(
            `${resolution.resolved_records} resolved source-cache binding(s) for ${resolution.required_records} that required one, although a release is only cut when every one of them resolved`,
        );
    }
    if (resolution.required_records > evidence.published_foods) {
        refuse(
            `${resolution.required_records} row(s) requiring a source-cache binding among ${evidence.published_foods} published food(s)`,
        );
    }
    if (resolution.required_records > 0 && resolution.cache_rows_read === 0) {
        refuse('no usda_api_cache row read at all, although it counted rows whose digests were resolved against one');
    }
};

/**
 * Refuses a `model_versions` block that is not made of strings.
 *
 * The cheap structural check that the collapsed-and-fabricated version would
 * have failed: the coverage plan's `generationModel` is a configuration OBJECT,
 * it was assigned straight into a field typed `string | null`, and TypeScript
 * accepted it because the plan's declared type said `string`. A manifest is
 * evidence, so the last thing done before writing one is to assert that every
 * provenance value is a string, a null, or an array of strings — the shape the
 * release format contract states and the shape catalog-load.ts and any reviewer
 * will read.
 */
const assertMeasuredModelVersions = (versions: CatalogReleaseModelVersions): void => {
    for (const [field, value] of Object.entries(versions)) {
        const ok =
            value === null ||
            typeof value === 'string' ||
            typeof value === 'number' ||
            (Array.isArray(value) && value.every((entry) => typeof entry === 'string'));
        if (!ok) {
            throw new ReleaseIntegrityError(
                `model_versions.${field} is not a string, a null or a list of strings, so the release manifest would record provenance that no reader can interpret: ${JSON.stringify(
                    value,
                )}. model_versions is measured from the exported rows' generation batches and llm_review records; configuration is never written there.`,
                { file: RELEASE_MANIFEST_FILE_NAME },
            );
        }
    }
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
 * What an operator can actually do about a restricted pass that moved the
 * published set, stated as it is rather than as one would wish it.
 *
 * "Re-run catalog:validate" is NOT the remedy here, and saying so would be
 * advice that cannot work: the canonical run key names the coverage plan and the
 * last completed ingest, neither of which a validation pass changes, so the
 * canonical row is already succeeded and re-running the stage is answered by
 * the completed-run no-op (catalog-validate's `run_already_completed`, which
 * writes nothing at all). The two things that DO create a new canonical run are
 * the two that message itself names, and they are named here for the same
 * reason: an operator reading a refusal needs the action that clears it.
 *
 * The narrower repair — having a restricted pass that changes dispositions
 * invalidate the canonical judgement, so an ordinary re-validation becomes
 * available — belongs to catalog-validate.ts and lib/checkpoint.ts, which own
 * the run key. This stage's job is to refuse to certify a set its canonical
 * evidence does not cover.
 */
const RESTRICTED_VALIDATION_REMEDY =
    'Cut the release from a catalog whose canonical pass is the last word on it: a newer catalog:import or ' +
    'catalog:load, or a new coveragePlanVersion, each creates a new canonical validation run, and re-running ' +
    'catalog:validate against this same input and plan is the completed-run no-op. Until one of those has judged ' +
    'the whole plan again, this database has no canonical judgement of the set it now holds.';

/**
 * How many food publication statuses a validation run's ledger says it CHANGED,
 * or `null` when its counts do not say.
 *
 * Pure over the column so the rule that reads it is testable without a
 * database. `judged` is tallied once per row the pass judged and `unchanged`
 * once per judged row whose status did not move (catalog-validate.ts), and both
 * reach the row through the periodic flush and the close, whatever the outcome —
 * so the difference is the number of dispositions the pass moved. Absent
 * `judged` yields `null` rather than `0`: "the counts do not state it" and "it
 * changed nothing" are different facts, and the caller treats them differently.
 */
export const validationDispositionChanges = (counts: unknown): number | null => {
    if (counts === null || typeof counts !== 'object' || Array.isArray(counts)) {
        return null;
    }
    const readCount = (key: string): number | null => {
        const value = (counts as Record<string, unknown>)[key];
        return typeof value === 'number' && Number.isFinite(value) ? value : null;
    };
    const judged = readCount('judged');
    if (judged === null) {
        return null;
    }
    // A negative difference is not a fact about the catalog — it is a row whose
    // two counters disagree — so it is reported as "changed nothing" rather
    // than as a negative number the message would print.
    return Math.max(0, judged - (readCount('unchanged') ?? 0));
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
        // `counts` is selected because one rule needs a run's own statement of
        // what it CHANGED rather than only when it ran: a restricted validation
        // pass that republished rows after the canonical pass moved the
        // published set, and the only durable record of that is this column.
        select: { kind: true, manifest_version: true, status: true, finished_at: true, counts: true },
        orderBy: { finished_at: 'asc' },
    });

/**
 * Why this database is not ready to be released, or `null` when it is.
 *
 * Pure over the run rows so every rule is testable without a database. Five
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
 *   4. a later RESTRICTED pass of this same catalog that changed publication
 *      statuses, or whose ledger cannot show that it did not — either way the
 *      canonical verdicts can no longer be shown to be the published set, so
 *      the canonical success cannot vouch for what this release would ship;
 *   5. an ingest that finished after that validation — the rows it touched are
 *      unpublished right now.
 *
 * A run whose `finished_at` is null never finished and says nothing about
 * ORDER, so rules 3, 4 and 5 ignore it — which is exactly why the open-run rule
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

    // WHAT THE CANONICAL PASS JUDGED MUST STILL BE WHAT THIS RELEASE SHIPS.
    //
    // The rule above establishes that a full pass of this catalog under this
    // plan succeeded. It does not establish that its verdicts are still the
    // published set, because validation itself can move that set afterwards: a
    // restricted pass — `--category`, `--revalidate-quarantined`, `--review`,
    // each of which claims `<canonicalKey>+scope:<hash>` — publishes,
    // quarantines and rejects rows exactly as the full pass does, over a
    // FRACTION of the plan. Run after the canonical pass, it leaves a database
    // whose published set is partly the canonical pass's judgement and partly
    // its own, while the ledger still shows the canonical success as the last
    // word. catalog-validate states the consequence outright where it keeps
    // `--review` out of the canonical key: a release is meant to "rest on a
    // validation that consulted no model", and a `--review` pass that published
    // a row defeats that silently.
    //
    // Only passes over THIS catalog under THIS plan are considered — keys of the
    // form `<expectedKey>+scope:…`. A row naming another input or another plan
    // is judged by the rule above, and that prefix is also what keeps
    // housekeeping out of this rule entirely:
    // `settleUnresumableValidationRuns` closes runs whose parsed input DIFFERS
    // from the current one and leaves a run for the current input untouched
    // whatever its state (catalog-validate.ts), so a settled row never carries
    // this prefix and never reaches the loop below. No exemption is owed to it.
    //
    // WHAT COUNTS AS EVIDENCE, AND WHY ABSENT EVIDENCE IS A REFUSAL. A pass
    // records what it did in `counts`: `judged` per row it judged and
    // `unchanged` for each of those whose status did not move. `judged −
    // unchanged` is therefore the number of dispositions it CHANGED, and it is
    // the one question asked here:
    //
    //   * more than zero — the published set is not the canonically judged set,
    //     and the release is refused;
    //   * zero — the pass judged rows and moved none, so the canonical verdicts
    //     still describe the set; allowed, and logged;
    //   * unreadable — refused, whatever the row's status.
    //
    // That last branch is a refusal and not a warning because of the order
    // catalog-validate.ts writes in: each judged food's new publication status
    // is COMMITTED in its own transaction and only then tallied in memory
    // (catalog-validate.ts, EVERY TALLY HAPPENS HERE), with the tallies reaching
    // the ledger on a periodic flush. A pass that stopped between a commit and
    // the next flush has therefore left status changes in the database that its
    // `counts` do not mention at all — so a row that states nothing cannot be
    // read as "it changed nothing", in either direction, and `failed` is not an
    // excuse: it is the status such a pass would most likely carry. A release is
    // an artefact other environments load, so the unreadable case resolves
    // against publishing rather than for it, and the remedy is the same one a
    // changed set gets.
    const restrictedPrefix = `${expectedKey}${VALIDATION_SCOPE_SEPARATOR}`;
    const laterRestricted = runs
        .filter(
            (run) =>
                run.kind === 'validation' &&
                run.manifest_version.startsWith(restrictedPrefix) &&
                run.finished_at !== null &&
                (run.finished_at as Date).getTime() > (canonicalSuccess.finished_at as Date).getTime(),
        )
        // Deterministic: the same ledger always names the same run.
        .sort((left, right) => {
            const byTime = (left.finished_at as Date).getTime() - (right.finished_at as Date).getTime();
            return byTime !== 0 ? byTime : left.manifest_version < right.manifest_version ? -1 : 1;
        });

    for (const run of laterRestricted) {
        const changes = validationDispositionChanges(run.counts);
        if (changes === null) {
            return (
                `a restricted catalog:validate run (${run.manifest_version}) ` +
                `${run.status === 'succeeded' ? 'finished' : run.status.toUpperCase()} at ` +
                `${(run.finished_at as Date).toISOString()}, after the canonical pass at ` +
                `${(canonicalSuccess.finished_at as Date).toISOString()}, and its ledger records no judged/unchanged ` +
                'counts — so it cannot be shown to have left the canonically judged set intact. A pass commits each ' +
                "food's new publication status before it tallies it, so one that stopped before its counts reached the " +
                'ledger may have changed statuses this ledger says nothing about; its outcome does not excuse it from ' +
                'this rule. ' +
                RESTRICTED_VALIDATION_REMEDY
            );
        }
        if (changes > 0) {
            return (
                `a restricted catalog:validate run (${run.manifest_version}) finished at ` +
                `${(run.finished_at as Date).toISOString()}, after the canonical pass at ` +
                `${(canonicalSuccess.finished_at as Date).toISOString()}, and changed ${changes} food publication ` +
                `status(es)${laterRestricted.length > 1 ? ` (${laterRestricted.length} restricted runs ran since)` : ''}. ` +
                'That pass judged only part of the plan, so the published set this release would ship is no longer the ' +
                'set the canonical pass judged, and the canonical success cannot vouch for it. ' +
                RESTRICTED_VALIDATION_REMEDY
            );
        }
        // The one allowance this rule makes, and it is evidenced: the pass
        // stated how many rows it judged and that none of their statuses moved.
        logger.info('restricted_validation_changed_nothing', {
            stage: STAGE,
            runScope: run.manifest_version,
            status: run.status,
            finishedAt: (run.finished_at as Date).toISOString(),
        });
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

/**
 * The finished export was not allowed to take its reviewed path — the
 * destination already holds a release and `--force` was not given, another
 * publication holds the lock on that path, or the staging directory the export
 * wrote is no longer the directory those bytes went into.
 *
 * Its own class, and its own code per refusal, because these are the failures
 * of this stage that are about WHERE the release goes rather than about the
 * catalog: nothing is wrong with the bytes that were exported, and an operator
 * reading `release_directory_exists` has a different next action from one
 * reading `release_integrity_failed`. The code is a constructor argument rather
 * than a per-class constant so those refusals stay one concept with one
 * recovery path (the staging directory is discarded in every case) while still
 * reporting distinguishably.
 */
export class ReleasePublicationError extends CatalogReleaseError {
    public readonly code: string;

    public constructor(code: string, message: string, context: CatalogReleaseErrorContext = {}) {
        super(message, context);
        this.name = 'ReleasePublicationError';
        this.code = code;
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
 * The shared head of every staging name for one final release path.
 *
 * Exported as one definition because two things depend on it agreeing: the
 * name a run creates, and the pattern the orphan sweep recognises. Two
 * spellings of "this release's staging directory" would leave a killed run's
 * directory behind forever, or sweep something that is not one.
 */
export const stagingPrefixFor = (finalDirectory: string): string =>
    `.${path.basename(finalDirectory)}.staging-`;

/**
 * The staging directory for a release: a hidden SIBLING of the final one, named
 * so that no other local principal can predict it.
 *
 * Sibling, not a temp directory: `rename` is only atomic within one
 * filesystem, and `os.tmpdir()` is routinely a different mount, where the move
 * would fail with `EXDEV` after the whole export had been written. Dot-prefixed
 * so it cannot be mistaken for a release id, and pid-suffixed so two runs
 * cannot stage over each other.
 *
 * WHY THE NAME CARRIES A NONCE. The parent is whatever `--out` named, so it can
 * be a directory another local principal may create names in, and a name that
 * principal can compute is a name they can pre-place as a symbolic link before
 * this run creates it. Sixteen hex characters from the CSPRNG make pre-placing
 * it a guess against 2^64 rather than a plan, and the exclusive create this
 * name is brought into existence with refuses the guess that lands. The suffix
 * is a defaulted parameter, not a hidden read: a caller that must KNOW the path
 * — a suite asserting where a member was written — passes one, and every other
 * caller gets an unguessable one it does not have to think about.
 */
export const stagingDirFor = (
    finalDirectory: string,
    pid: number = process.pid,
    suffix: string = unguessableSuffix(),
): string => path.join(path.dirname(finalDirectory), `${stagingPrefixFor(finalDirectory)}${pid}-${suffix}`);

/** The 16 lowercase hex characters `unguessableSuffix` emits. */
const STAGING_NONCE_PATTERN = /^[0-9a-f]{16}$/;

const DIGITS_PATTERN = /^[0-9]+$/;

/**
 * The pid in a staging directory's name, or `null` when the name is not one of
 * this release's staging directories at all.
 *
 * The sweep's whole authority to delete something rests on this predicate, so
 * it is exact rather than a `startsWith`: the tail after the prefix must be a
 * pid, optionally followed by the nonce, and nothing else. `.v1.publish.lock`,
 * `.v1.superseded-900`, `v1` itself and a name whose nonce is the wrong shape
 * all answer `null` and are left alone.
 *
 * The nonce is OPTIONAL because both spellings name the same thing on disk: a
 * staging directory whose name carries no nonce is one this stage created
 * before the name was made unguessable, and a run killed then left an orphan
 * that is no less an orphan for being predictably named. A non-positive pid
 * answers `null` too — see `pidIsRunning` for why a 0 or a negative is never
 * asked about.
 */
export const orphanStagingPid = (entryName: string, finalDirectory: string): number | null => {
    const prefix = stagingPrefixFor(finalDirectory);
    if (!entryName.startsWith(prefix)) {
        return null;
    }

    const parts = entryName.slice(prefix.length).split('-');
    if (parts.length > 2) {
        return null;
    }
    const [pidPart, noncePart] = parts;
    if (!DIGITS_PATTERN.test(pidPart)) {
        return null;
    }
    if (noncePart !== undefined && !STAGING_NONCE_PATTERN.test(noncePart)) {
        return null;
    }

    const pid = Number(pidPart);
    return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
};

/**
 * Whether a process with this pid exists on THIS machine.
 *
 * `kill(pid, 0)` sends no signal and only asks the kernel about the target, and
 * each of its three answers is decisive: success and `EPERM` both mean a
 * process with that pid exists — `EPERM` is one belonging to another user —
 * while `ESRCH` means none does. Any other errno is answered "live", because
 * the sweep's consequence for a wrong answer is asymmetric: a lingering orphan
 * directory is housekeeping an operator can do, and a deleted live staging
 * directory is a running export's work destroyed.
 *
 * A pid that is not a positive safe integer is answered "live" WITHOUT asking:
 * `process.kill` reads 0 and negative values as process GROUPS, so signalling
 * one would reach processes this stage has no business touching. That is also
 * why `orphanStagingPid` refuses such a name before this function ever sees it
 * — two independent guards, because the failure mode is not recoverable.
 */
export const pidIsRunning = (pid: number): boolean => {
    if (!Number.isSafeInteger(pid) || pid <= 0) {
        return true;
    }

    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        return (error as NodeJS.ErrnoException).code !== 'ESRCH';
    }
};

export interface SweepOrphanStagingInput {
    /** The reviewed path whose siblings are searched. */
    readonly finalDirectory: string;
    /** The staging directory THIS run created, which is never swept. */
    readonly keep: string;
    readonly fileSystem: ReleaseFileSystem;
    /** Seamed so a suite can state which pids are live; defaults to the kernel. */
    readonly pidIsRunning?: (pid: number) => boolean;
    readonly logger: ScriptLogger;
}

/**
 * Removes the staging directories of runs that were killed before they could
 * clean up, and returns what it removed.
 *
 * WHY A SWEEP RATHER THAN ONE REMOVE. This housekeeping used to be a single
 * `removeDir` of the name this run was about to create, which only worked
 * because that name was derived from the pid and therefore predictable — the
 * same property that let another principal pre-place a symlink there. With the
 * name carrying a nonce, a killed run's directory is a name nobody will compute
 * again, so it is found by listing the parent instead.
 *
 * WHAT IT WILL NOT TOUCH, each refusal load-bearing:
 *
 *   * anything whose name is not exactly one of this release's staging
 *     directories (`orphanStagingPid`), so the release directory, the
 *     publication lock and a `.superseded-` directory are never candidates;
 *   * the staging directory this run created, which it is still writing into;
 *   * a candidate whose pid is a live process, which is a CONCURRENT export's
 *     staging directory: two releases of one database are meant to be able to
 *     run at once, and a blind sweep would delete one run's members from under
 *     it;
 *   * anything that is not a real directory under `lstat`. A symbolic link
 *     bearing a staging name is reported and left exactly where it is:
 *     following it would delete a tree somewhere else entirely, and removing
 *     the link would quietly repair a filesystem an operator needs to see.
 */
export const sweepOrphanStagingDirectories = (input: SweepOrphanStagingInput): readonly string[] => {
    const { finalDirectory, keep, fileSystem, logger } = input;
    const isRunning = input.pidIsRunning ?? pidIsRunning;
    const parent = path.dirname(finalDirectory);
    const keepName = path.basename(keep);
    const removed: string[] = [];

    for (const entryName of fileSystem.listDirectoryNames(parent)) {
        const pid = orphanStagingPid(entryName, finalDirectory);
        if (pid === null || entryName === keepName) {
            continue;
        }

        const candidate = path.join(parent, entryName);
        if (isRunning(pid)) {
            logger.info('release_staging_in_use_retained', {
                stage: STAGE,
                directory: candidate,
                holdingPid: pid,
                reason: 'a process with this pid is running, so the directory belongs to an export still writing into it',
            });
            continue;
        }

        if (fileSystem.directoryIdentity(candidate) === null) {
            logger.warn('release_staging_name_not_a_directory', {
                stage: STAGE,
                path: candidate,
                consequence:
                    'An entry bearing a staging name is not a directory — a symbolic link, most likely — so it was ' +
                    'left untouched. Nothing this stage wrote is there; inspect it and remove it by hand.',
            });
            continue;
        }

        // The contents describe nothing: the manifest that would make them a
        // release was never written, since a completed run renames its staging
        // directory away instead of leaving it here.
        fileSystem.removeDir(candidate);
        removed.push(candidate);
        logger.info('release_staging_orphan_discarded', {
            stage: STAGE,
            directory: candidate,
            holdingPid: pid,
            reason: 'no process with this pid is running, so the run that staged here was killed before it finished',
        });
    }

    return removed;
};

/**
 * The lock a publication holds over ONE final release path.
 *
 * A sibling of the directory it protects, so it is on the same filesystem and
 * one operator can see both; dot-prefixed so it is never mistaken for a release
 * id.
 */
export const publicationLockFor = (finalDirectory: string): string =>
    path.join(path.dirname(finalDirectory), `.${path.basename(finalDirectory)}.publish.lock`);

/**
 * The question `assertStagingIdentityUnchanged` answers, as its two callers
 * ask it. Module-private: the check is an internal invariant of this stage's
 * publication path, pinned through `publishRelease` and `runReleaseStage`
 * rather than called directly.
 */
interface StagingIdentityCheck {
    readonly stagingDirectory: string;
    /** The reading taken when this run CREATED that directory. */
    readonly stagingIdentity: ReleaseDirectoryIdentity;
    /** The directory an operator is sent to look at; the release's parent. */
    readonly parentDirectory: string;
    /**
     * What did not happen because of the refusal, in the operator's terms —
     * "nothing was published to …", "no member was written …". The caller
     * states it because only the caller knows which act was being authorised.
     */
    readonly consequence: string;
    readonly directoryIdentity: (absolutePath: string) => ReleaseDirectoryIdentity | null;
}

/**
 * Refuses unless `stagingDirectory` still names the directory whose identity
 * was captured when this run created it.
 *
 * ONE DEFINITION, TWO CALL SITES, because the two are the same question asked
 * at different moments and a second spelling of it would be a second place to
 * get the comparison wrong. The export asks immediately before every path-based
 * member operation (`assertReleaseDirectoryUnchanged` on RunReleaseDeps) and
 * publication asks immediately before each move of the directory, so nothing
 * separates a check from the act it authorises. The comparison is `(dev, ino)`
 * rather than the spelling: a replaced directory has the same name by
 * construction, which is exactly why the attack works at all.
 *
 * `null` — no directory at that name, or an entry that is not one — never
 * matches, so a staging path that became a symbolic link is refused however it
 * resolves.
 */
const assertStagingIdentityUnchanged = (check: StagingIdentityCheck): void => {
    const current = check.directoryIdentity(check.stagingDirectory);
    if (sameDirectoryIdentity(current, check.stagingIdentity)) {
        return;
    }

    throw new ReleasePublicationError(
        'release_staging_identity_changed',
        `${check.stagingDirectory} is no longer the directory this run exported into, so ${check.consequence}. The name now refers to ${current === null ? 'no directory at all' : `a different directory (dev ${current.dev}, inode ${current.ino} rather than dev ${check.stagingIdentity.dev}, inode ${check.stagingIdentity.ino})`}. Something replaced it while the export was running: check who can write to ${check.parentDirectory}, then re-run catalog:release.`,
    );
};

export interface PublishReleaseInput {
    readonly stagingDirectory: string;
    /**
     * The identity of the staging directory as it was CREATED, carried from
     * there to here so publication can establish that the path still names that
     * same directory. Required rather than re-read here: a reading taken at
     * publication time could only be compared with itself.
     */
    readonly stagingIdentity: ReleaseDirectoryIdentity;
    readonly finalDirectory: string;
    /** The operator's `--force`. Publication enforces it; preflight only warns early. */
    readonly force: boolean;
    readonly pid: number;
    readonly now: () => Date;
    readonly fileSystem: ReleaseFileSystem;
    readonly logger: ScriptLogger;
}

/**
 * Moves the finished staging directory into its reviewed path.
 *
 * WHY THE OVERWRITE RULE IS DECIDED HERE AND NOT ONLY IN PREFLIGHT. Preflight
 * runs before the export — minutes before, on a full catalog — so what it
 * observed is not what publication faces: two runs can both pass it while
 * neither directory exists, and the second to finish would then replace a
 * reviewed, checksummed release the first had just published, with no `--force`
 * anywhere on its command line. That is what this function used to do: it
 * re-derived "am I replacing something" from disk and took the move-aside path
 * unconditionally, because `force` was never passed to it at all. Preflight
 * remains, because failing in a second beats failing after a ten-minute export,
 * but the authoritative check is the one taken here, under the lock, on the
 * state that is actually about to be overwritten.
 *
 * SERIALISED BY FINAL PATH. The stage lock this run holds is SHARED — two
 * exports of one database are harmless and are meant to be able to run at once
 * — so it cannot order two publications. An atomic create-exclusive lock file
 * beside the destination can, and it is the same idiom lib/rateLimiter.ts uses
 * for its cross-process ledger. It is refused rather than waited on: a
 * publication is milliseconds of renames, so a lock that is held means either a
 * concurrent run (whose release should not be replaced from under it) or a
 * crashed one (whose lock an operator should look at), and both are better
 * stated than queued behind.
 *
 * With nothing at the destination this is one `rename`, and a release therefore
 * appears complete or not at all.
 *
 * Replacing an existing release (only with `--force`) takes three steps,
 * because `rename` onto a non-empty directory fails with `ENOTEMPTY`. The OLD
 * release is moved aside FIRST and deleted LAST, which is the ordering that
 * cannot lose it: a run interrupted between the steps leaves the old release
 * under its `.superseded-` name, where an operator can see it and move it back,
 * whereas deleting first would destroy a reviewed artefact to make room for one
 * that might never arrive.
 *
 * TWO THINGS ARE ESTABLISHED ABOUT THE PATHS BEFORE ANYTHING MOVES, because an
 * export takes minutes and every check made before it is a statement about a
 * filesystem that has had minutes to change:
 *
 *   * the parent of the final directory is still one no other local principal
 *     can plant a name in. Three things land in it — the lock file, the
 *     `.superseded-` directory and the release itself — and a parent that
 *     became group-writable during the export is one where the lock can be
 *     created by someone else and the reviewed release moved aside by someone
 *     else;
 *   * the staging directory is still the directory this run exported into,
 *     compared by `(dev, ino)` and not by its spelling. Without that, a
 *     staging path re-pointed at a tree an attacker prepared would be renamed
 *     into the reviewed release path by this function, and the result would
 *     carry a manifest whose digests describe files nobody in this pipeline
 *     wrote. This is the LAST of those checks rather than the only one: the
 *     export has already made the same one immediately before each member
 *     open, read-back and manifest write, so a replacement is refused where it
 *     would have redirected bytes and not merely where it would have published
 *     them.
 */
export const publishRelease = (input: PublishReleaseInput): void => {
    const { stagingDirectory, stagingIdentity, finalDirectory, force, pid, fileSystem, logger } = input;

    // The lock is a sibling of the destination, so its parent has to exist
    // before it can be taken. With --out that parent may be a directory only
    // this run has any reason to create.
    fileSystem.ensureDir(path.dirname(finalDirectory));

    // Held to the same rule the staging directory's creation was held to, and
    // re-established here rather than trusted from then: this is the last
    // moment before a lock file is created and a reviewed release is moved in
    // that parent.
    fileSystem.assertSafeParent(finalDirectory);

    /**
     * The identity check, bound to this publication's paths. Called immediately
     * before each move of the staging directory, so nothing separates the check
     * from the act it authorises; the export has already made the same check
     * before each of its own path uses.
     */
    const assertStagingUnmoved = (): void => {
        assertStagingIdentityUnchanged({
            stagingDirectory,
            stagingIdentity,
            parentDirectory: path.dirname(finalDirectory),
            consequence: `nothing was published to ${finalDirectory}`,
            directoryIdentity: fileSystem.directoryIdentity,
        });
    };

    const lockPath = publicationLockFor(finalDirectory);
    const owner = `${JSON.stringify({ pid, at: input.now().toISOString(), staging: stagingDirectory })}\n`;
    if (!fileSystem.createFileExclusive(lockPath, owner)) {
        throw new ReleasePublicationError(
            'release_publication_locked',
            `another release publication holds ${lockPath}, so this run will not touch ${finalDirectory}. Wait for that run to finish; if no release is running, that lock file is left over from one that was killed — read it to see which process held it, then delete it.`,
        );
    }

    try {
        // RECHECKED HERE, inside the lock and immediately before the rename, so
        // the decision is made on the state being overwritten rather than on
        // the state preflight saw.
        const replacing = fileSystem.directoryExists(finalDirectory);

        if (replacing && !force) {
            throw new ReleasePublicationError(
                'release_directory_exists',
                `${finalDirectory} already holds a release, and a release directory is a reviewed, checksummed artefact other environments load. It appeared after this run's preflight — another run published it, or it was restored — so this run will not replace it. Choose the next release id, or re-run with --force to overwrite ${finalDirectory}.`,
            );
        }

        if (!replacing) {
            assertStagingUnmoved();
            fileSystem.rename(stagingDirectory, finalDirectory);
            logger.info('release_published', { stage: STAGE, directory: finalDirectory, replaced: false });
            return;
        }

        const supersededDirectory = path.join(
            path.dirname(finalDirectory),
            `.${path.basename(finalDirectory)}.superseded-${pid}`,
        );
        fileSystem.removeDir(supersededDirectory);
        fileSystem.rename(finalDirectory, supersededDirectory);
        try {
            // Inside this try, so an identity that changed under the export is
            // refused with the reviewed release put back rather than left aside
            // under a name nothing loads.
            assertStagingUnmoved();
            fileSystem.rename(stagingDirectory, finalDirectory);
        } catch (error) {
            // The new release could not take the path, so the old one is put back
            // rather than left aside under a name nothing loads.
            fileSystem.rename(supersededDirectory, finalDirectory);
            throw error;
        }
        fileSystem.removeDir(supersededDirectory);
        logger.info('release_published', { stage: STAGE, directory: finalDirectory, replaced: true });
    } finally {
        // Released whatever happened, and only by the run that took it: the
        // acquisition above returned false for anybody else, so reaching here
        // means this process owns the file.
        fileSystem.removeFile(lockPath);
    }
};

// ---------------------------------------------------------------------------
// The stage, end to end.
//
// One exported function owns the whole of it — discard a stale staging
// directory, open the ledger row, export, publish, close the ledger row — and
// takes every effect it has through its deps (Rule backend-architecture §4).
// Before, `main()` owned the half of the stage that decides whether a reviewed
// release is replaced and what the ledger ends up saying about it, reaching for
// `fs` and `process.pid` directly, so that half was unreachable from any test:
// `main()` is guarded behind `require.main === module`, which is exactly why
// the run* seam exists for the other four stages.
// ---------------------------------------------------------------------------

export interface RunReleaseStageDeps {
    readonly db: ReleaseDb;
    readonly coveragePlan: CoveragePlan;
    readonly release: string;
    /** The operator's `--force`, enforced at publication. */
    readonly force: boolean;
    /** The reviewed path this release is published to. */
    readonly finalDirectory: string;
    readonly logger: ScriptLogger;
    readonly now: () => Date;
    /** Names the staging directory and the superseded one; injected, never read from `process`. */
    readonly pid: number;
    readonly fileSystem: ReleaseFileSystem;
    readonly pageSize?: number;
    /**
     * The unguessable component of the staging directory's name. Optional and
     * generated per run: a caller that has to KNOW the staging path — a suite
     * asserting which member was written where — fixes it, and every other
     * caller gets 16 hex characters from the CSPRNG, which is what stops the
     * name from being pre-placed by another local principal.
     */
    readonly stagingSuffix?: string;
    /**
     * Whether a pid names a live process, which is how the orphan sweep tells a
     * killed run's staging directory from one a concurrent export is still
     * writing into. Optional, defaulting to the kernel's answer; seamed because
     * a suite cannot arrange for a pid to be dead.
     */
    readonly pidIsRunning?: (pid: number) => boolean;
    /**
     * The export step. Optional, defaulting to `runRelease`: the orchestration
     * is what this function owns, and a caller proving the ledger and
     * publication behaviour should not have to build a catalog to do it.
     */
    readonly runExport?: (deps: RunReleaseDeps) => Promise<ReleaseOutcome>;
    /** The publication step, seamed for the same reason. */
    readonly publish?: (input: PublishReleaseInput) => void;
}

/** What the ledger row records while the export is still running. */
const RELEASE_LEDGER_KIND = 'release';

/**
 * Cuts a release: the export, its publication, and the ledger row that says
 * whether both happened.
 *
 * THE LEDGER ROW IS OPENED FIRST AND CLOSED LAST, which is the ordering the
 * row's meaning requires. 'running' from before the export means a killed run
 * leaves a row that says what it was: an attempt that did not finish. The
 * outcome is written once publication has either succeeded or failed — so
 * 'succeeded' in this ledger is a statement that the six members are at the
 * reviewed path, and never, as it was, a statement made while the rename was
 * still ahead of it. A failure records 'failed' with its code and discards the
 * staging directory, so a refused run leaves no release and no silence.
 *
 * The kind is written directly rather than through checkpoint.ts, whose kind
 * union covers the four stages that RESUME; this one does not resume — it
 * re-cuts. No rule reads a 'release' row (MUTATING_RUN_KINDS and
 * GRAPH_MUTATING_RUN_KINDS both exclude it), so an open or failed row here
 * blocks nothing and is purely the audit trail an operator reads.
 *
 * THE STAGING DIRECTORY EXISTS BEFORE THE FIRST AWAIT, and that ordering is a
 * security property rather than a preference. The name used to be predictable
 * and was REMOVED here, after which this function awaited a database round
 * trip before the export created it: inside that window — which is as long as
 * the database takes to answer — another local principal who can write to the
 * parent could create that computable name as a symbolic link, or as a
 * directory holding symlinked member names, and every member write, manifest
 * included, would have landed wherever those links pointed. So the directory is
 * created FIRST, atomically, at a name carrying a nonce (`stagingDirFor`), and
 * the ledger row that follows records the path that already exists. There is
 * nothing left to remove before an await, because the create refuses an
 * existing name instead of clearing it.
 *
 * AND ITS IDENTITY IS RE-ASKED, NOT CARRIED, FOR THE WHOLE OF THE EXPORT.
 * Creating the directory first closes the window before the export and nothing
 * more: the ledger row is awaited, then the snapshot, then a page of rows per
 * member, and every member open resolves the staging PATHNAME again. A staging
 * directory replaced inside that window by a symbolic link — the parent may be
 * a directory another principal can create names in, which is why the nonce
 * exists — would have each `path.join(staging, member)` traverse the
 * replacement, and the member bytes would land wherever it pointed; the
 * exclusive no-follow open settles the member's own last component and says
 * nothing about the directory above it. So the `(dev, ino)` reading taken here
 * is threaded into the export as `assertReleaseDirectoryUnchanged` and re-asked
 * immediately before each of its path uses, and asked again immediately before
 * each rename publication performs. Node offers no descriptor-relative
 * `openat`, so this narrows the window to one `lstat`-to-syscall interval per
 * operation rather than removing it — which is stated here because a reader
 * deciding whether to add a guard elsewhere needs the residual, not a claim
 * that the race is gone.
 */
export const runReleaseStage = async (deps: RunReleaseStageDeps): Promise<ReleaseOutcome> => {
    const { logger, fileSystem } = deps;
    const stagingDirectory = stagingDirFor(deps.finalDirectory, deps.pid, deps.stagingSuffix ?? unguessableSuffix());

    // THE PARENT IS ESTABLISHED BEFORE THE NAME IS CREATED, and stated here
    // rather than left to the create. `createDirectoryExclusive` holds its
    // argument to the same rule, so on the real filesystem this is the check
    // twice; that redundancy is the point. The rule this stage depends on is
    // "the directory the six members are staged in sits in a parent no other
    // local principal can plant a name in", and the export — not the primitive
    // — is what that rule protects, so it is asserted where the export begins
    // and not only inside a helper a future refactor could reach past. It is
    // also the first filesystem effect of the stage, so a hostile parent is a
    // refusal before a directory exists or a ledger row is opened.
    fileSystem.assertSafeParent(stagingDirectory);

    // The atomic test-and-create, and the only thing that brings this name into
    // existence: an entry of any kind already at this name — a symbolic link
    // above all — fails the create rather than being written through.
    fileSystem.createDirectoryExclusive(stagingDirectory);

    // Captured now, while the directory is one this call just brought into
    // existence, and carried to publication so the rename that publishes a
    // release can establish that it is moving THIS directory.
    const stagingIdentity = fileSystem.directoryIdentity(stagingDirectory);
    if (stagingIdentity === null) {
        throw new ReleasePublicationError(
            'release_staging_unidentifiable',
            `${stagingDirectory} was created for this release but does not read back as a directory, so nothing can establish later that the release being published is the one this run exported. Nothing was written. Check ${path.dirname(deps.finalDirectory)} and re-run catalog:release.`,
        );
    }

    // Staging directories left behind by runs that were killed before they
    // could clean up. Swept after this run's own directory exists, so the sweep
    // reads a parent whose safety the create above has just established, and
    // never the moment before it.
    sweepOrphanStagingDirectories({
        finalDirectory: deps.finalDirectory,
        keep: stagingDirectory,
        fileSystem,
        pidIsRunning: deps.pidIsRunning,
        logger,
    });

    /**
     * The identity check the export makes before every path-based member
     * operation, closed over the reading taken above.
     *
     * Everything from here to publication happens after an `await` — the ledger
     * row, then the snapshot, then a page of rows per member write — and a
     * pathname is re-resolved from the filesystem root on every use. So the
     * captured identity is not a fact established once and carried; it is a
     * question re-asked at each use, which is what `runRelease` does with this.
     */
    const assertStagingUnchanged = (): void => {
        assertStagingIdentityUnchanged({
            stagingDirectory,
            stagingIdentity,
            parentDirectory: path.dirname(deps.finalDirectory),
            consequence: `no member was written through it and nothing was published to ${deps.finalDirectory}`,
            directoryIdentity: fileSystem.directoryIdentity,
        });
    };

    const startedAt = deps.now();
    const ledgerRunId = await openReleaseLedgerRow(deps, startedAt, stagingDirectory);

    const runExport = deps.runExport ?? runRelease;
    const publish = deps.publish ?? publishRelease;

    let outcome: ReleaseOutcome;
    try {
        outcome = await runExport({
            db: deps.db,
            coveragePlan: deps.coveragePlan,
            release: deps.release,
            logger,
            now: deps.now,
            // The STAGING directory, not the final one: nothing writes to the
            // reviewed path until every member and the manifest exist.
            releaseDir: () => stagingDirectory,
            writeFile: fileSystem.writeFile,
            readFileBytes: fileSystem.readFileBytes,
            ensureDir: fileSystem.ensureDir,
            openWriter: fileSystem.openWriter,
            // Supplied by the only caller that STAGES, which is the only caller
            // with an identity to compare. Without it the export would write
            // through whatever the staging pathname resolved to at the moment
            // of each open, and publication's refusal afterwards would come
            // after the bytes had already left the process.
            assertReleaseDirectoryUnchanged: assertStagingUnchanged,
            pageSize: deps.pageSize,
        });

        publish({
            stagingDirectory,
            stagingIdentity,
            finalDirectory: deps.finalDirectory,
            force: deps.force,
            pid: deps.pid,
            now: deps.now,
            fileSystem,
            logger,
        });
    } catch (error) {
        // A REFUSAL LEAVES NO RELEASE, NOT A PARTIAL ONE. Whatever members the
        // walk had written go with the staging directory, so the failure cannot
        // be mistaken for a release later — and the previously reviewed release,
        // if there is one, is still exactly where it was.
        fileSystem.removeDir(stagingDirectory);
        await closeReleaseLedgerRow(deps, ledgerRunId, {
            status: 'failed',
            startedAt,
            event: 'release_discarded',
            detail: describeFailure(error),
        });
        logger.error('release_discarded', {
            stage: STAGE,
            release: deps.release,
            staging: stagingDirectory,
            error: safeError(error),
        });
        throw error;
    }

    await closeReleaseLedgerRow(deps, ledgerRunId, {
        status: 'succeeded',
        startedAt,
        event: 'release_published',
        counts: outcome.counts,
    });

    return outcome;
};

/**
 * Opens the release's ledger row as 'running'.
 *
 * Written before the export rather than after it, so the row exists for the
 * whole time the stage is doing work and a killed run is visible as one.
 */
const openReleaseLedgerRow = async (
    deps: RunReleaseStageDeps,
    startedAt: Date,
    stagingDirectory: string,
): Promise<string> => {
    const row = await deps.db.catalog_import_runs.create({
        data: {
            kind: RELEASE_LEDGER_KIND,
            manifest_version: deps.release,
            started_at: startedAt,
            finished_at: null,
            status: 'running',
            cursor: { release: deps.release, staging: stagingDirectory, final: deps.finalDirectory },
            counts: {},
            log: [{ event: 'release_started', at: startedAt.toISOString(), release: deps.release }],
        },
    });
    return row.id;
};

/**
 * Records the outcome on the release's ledger row.
 *
 * A failure to write it does not mask the failure that got here: the caller's
 * error is rethrown either way and the run exits non-zero, so the worst case is
 * an unsettled row an operator can see, rather than a swallowed refusal. On the
 * success path the inability to record the outcome IS the failure — the release
 * is at its path and the ledger does not say so — and it is raised as one.
 */
const closeReleaseLedgerRow = async (
    deps: RunReleaseStageDeps,
    runId: string,
    outcome: {
        readonly status: 'succeeded' | 'failed';
        readonly startedAt: Date;
        readonly event: string;
        readonly counts?: Readonly<Record<string, number>>;
        readonly detail?: { readonly code: string; readonly error: SafeErrorFields };
    },
): Promise<void> => {
    const finishedAt = deps.now();
    const entry: Record<string, unknown> = {
        event: outcome.event,
        at: finishedAt.toISOString(),
        release: deps.release,
        directory: deps.finalDirectory,
    };
    if (outcome.detail !== undefined) {
        entry.code = outcome.detail.code;
        entry.error = outcome.detail.error;
    }

    try {
        await deps.db.catalog_import_runs.update({
            where: { id: runId },
            data: {
                status: outcome.status,
                finished_at: finishedAt,
                counts: outcome.counts ?? {},
                log: [
                    { event: 'release_started', at: outcome.startedAt.toISOString(), release: deps.release },
                    entry,
                ],
            },
        });
    } catch (error) {
        deps.logger.error('release_ledger_unrecorded', {
            stage: STAGE,
            runId,
            release: deps.release,
            intendedStatus: outcome.status,
            error: safeError(error),
        });
        if (outcome.status === 'succeeded') {
            throw new CatalogReleaseError(
                `the release was published to ${deps.finalDirectory} but its ledger row ${runId} could not be closed, so the run ledger still shows it as running. Re-run catalog:release --force once the database is reachable, or settle the row by hand.`,
                { file: RELEASE_MANIFEST_FILE_NAME },
            );
        }
    }
};

/**
 * The stage's filesystem, on this machine.
 *
 * The one place `fs` is reached for outside the export's own writers, and it
 * holds no policy: each member is the smallest faithful wrapper, so what a test
 * substitutes is a filesystem and not a different set of rules.
 *
 * `createFileExclusive` is `openSync(path, 'wx')` because that is the atomic
 * primitive — the same one lib/rateLimiter.ts takes its cross-process ledger
 * lock with — and an `existsSync` check followed by a write is not: two runs
 * can both see nothing and both write.
 *
 * Four members are `lib/manifest.ts` primitives rather than `fs` calls —
 * `createDirectoryExclusive`, `assertSafeParent`, and the no-follow halves of
 * `writeFile` and `readFileBytes`. That is still the smallest faithful wrapper
 * of each operation: the rule for what a safe parent is, and for what an
 * exclusive no-follow create is, belongs to the module every publishing stage
 * shares, so this stage cannot drift into a second definition of it.
 */
export const nodeReleaseFileSystem: ReleaseFileSystem = {
    // Through the same writer every member takes, so the manifest — the one
    // file written by this member rather than by `openWriter` — is created
    // exclusively and without following a link at its own name, exactly like
    // the five members beside it. `fs.writeFileSync` would follow such a link
    // and truncate whatever it pointed at.
    writeFile: (absolutePath, contents) => {
        const writer = descriptorWriter(absolutePath);
        try {
            writer.write(contents);
        } finally {
            writer.close();
        }
    },
    // No-follow, and a regular file or nothing: this read is what the
    // manifest's SHA-256, row count and size are measured from, so a link at a
    // member's name would produce a manifest describing a file this pipeline
    // never wrote.
    readFileBytes: (absolutePath) => readArtifactFileNoFollow(absolutePath),
    ensureDir: (absolutePath) => {
        fs.mkdirSync(absolutePath, { recursive: true });
    },
    createDirectoryExclusive: (absolutePath) => {
        createExclusiveDirectory(absolutePath);
    },
    listDirectoryNames: (absolutePath) => {
        try {
            return fs.readdirSync(absolutePath);
        } catch (error) {
            const code = (error as NodeJS.ErrnoException).code;
            if (code === 'ENOENT' || code === 'ENOTDIR') {
                // The parent of the first release cut into this tree. Nothing
                // is listed because nothing is there, which is not a failure.
                return [];
            }
            throw error;
        }
    },
    directoryIdentity: (absolutePath) => {
        try {
            // `lstat`, not `stat`: a symbolic link must answer "not a
            // directory" however it resolves, because the entry AT this name is
            // what a caller is deciding about.
            const stats = fs.lstatSync(absolutePath);
            return stats.isDirectory() ? { dev: stats.dev, ino: stats.ino } : null;
        } catch (error) {
            // Absent, unreadable, or a path component that is not a directory.
            // All three are "this path does not name a directory I can
            // identify", which is what both callers need: the sweep skips it
            // and publication refuses. Reported so an unexpected errno is not
            // silently read as absence.
            logger.debug('release_directory_unidentified', {
                stage: STAGE,
                path: absolutePath,
                error: (error as Error).message,
            });
            return null;
        }
    },
    assertSafeParent: (absolutePath) => {
        assertSafeArtifactParent(absolutePath);
    },
    removeDir: (absolutePath) => {
        fs.rmSync(absolutePath, { recursive: true, force: true });
    },
    directoryExists: directoryExistsOnDisk,
    rename: (from, to) => {
        fs.renameSync(from, to);
    },
    createFileExclusive: (absolutePath, contents) => {
        let descriptor: number;
        try {
            descriptor = fs.openSync(absolutePath, 'wx');
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
                return false;
            }
            throw error;
        }
        try {
            fs.writeFileSync(descriptor, contents, 'utf-8');
        } finally {
            fs.closeSync(descriptor);
        }
        return true;
    },
    removeFile: (absolutePath) => {
        fs.rmSync(absolutePath, { force: true });
    },
    openWriter: descriptorWriter,
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
// The reported `error` is `SafeErrorFields` — a scrubbed name plus an optional
// machine code and status, and deliberately no `message`: this value reaches the
// durable run log and the operator console, where foreign prose can carry a
// connection URL, a key or a fragment of the document that failed (CWE-532).
const describeFailure = (error: unknown): { code: string; error: SafeErrorFields; detail?: LogFields } => {
    // The base type, not each subclass: every CatalogReleaseError reports its
    // own `code`, so a refusal added later is mapped here without this function
    // being touched — and none of them can fall through to `unexpected_error`.
    if (isThrownInstanceOf(error, CatalogReleaseError)) {
        return { code: error.code, error: safeError(error) };
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
        ...originLogFields(origin),
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

    // THE STAGE CLAIM, TAKEN SHARED. This stage only READS the catalog graph,
    // so two exports of one database are harmless and both may hold the lock;
    // what must not happen is an export running while an import, a generation
    // pass, a validation pass or a load is writing, and a shared lock is
    // refused exactly then (lib/checkpoint.ts's THE STAGE LOCK). It is the
    // outer half of the guarantee the Repeatable Read snapshot makes inside
    // runRelease: the lock keeps a mutator out for the whole export, the
    // snapshot makes every read describe one state even so. What it cannot do
    // is order two publications of one release id — being shared is the point —
    // which is why `publishRelease` takes its own exclusive claim on the final
    // path.
    //
    // Everything the stage then does belongs to `runReleaseStage`: this function
    // supplies the real database, clock, pid and filesystem and reads the
    // outcome.
    const outcome = await withCatalogStageLock({ stage: 'release', logger }, () =>
        runReleaseStage({
            db: prisma as unknown as ReleaseDb,
            coveragePlan: loadCoveragePlan(),
            release,
            force: parsed.options.force,
            finalDirectory,
            logger,
            now: () => new Date(),
            pid: process.pid,
            fileSystem: nodeReleaseFileSystem,
        }),
    );

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
