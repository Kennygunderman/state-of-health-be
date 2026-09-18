// Stage 4 of the catalog pipeline: the coverage and quality report.
//
// WHAT THIS STAGE DOES. It reads `catalog_foods` and
// `catalog_validation_records` and writes the two committed evidence artefacts:
//
//   data/meal-planning/reports/latest/validation-report.json
//       one machine-readable record per PUBLISHED food — its identity, the
//       provenance of its nutrition, the portions and the identity evidence
//       behind it, every check with the value observed and the bound that
//       observation was measured against, and for every vocabulary check the
//       item does NOT record, the reason its own facts show it could not be
//       evaluated — plus the three-tier rollup, the per-category quarantine
//       counts over the same rows, and the withheld-identity audit that names
//       every candidate, quarantined and rejected row the catalog held back.
//
//   data/meal-planning/reports/latest/import-report.json
//       the aggregate half only: counts by category, identity source and
//       nutrition provenance, the duplicate and quarantine figures, the same
//       withheld-identity audit, the coverage gaps, and the EXACT per-category
//       shortfall. Every other field in that file belongs to `catalog:import`
//       and is preserved untouched.
//
// WHY A CLAIM IN THIS FILE IS ALWAYS COMPUTED. Two kinds of statement can be
// wrong in an evidence artefact: a measurement that disagrees with the rows,
// and a CLAIM ABOUT the measurements that nothing checked. The second is the
// more dangerous, because it reads as a conclusion. So every such claim here —
// that every published item accounts for every check, that the whole list of
// withheld identities is present, that a category met its target — is derived
// from the counters beside it and states the unmet case when it does not hold.
// The superseded-key prune below exists for the same reason: a claim an earlier
// producer wrote must not survive into a document whose data contradicts it.
//
// THIS STAGE IS READ-ONLY. It is the evidence stage, and evidence that could
// alter its subject is not evidence. There is no `create`, `update`, `upsert`,
// `delete`, `createMany`, `updateMany` or `executeRaw` anywhere in this file,
// and {@link ReportDb} — the slice of the client this stage may use — declares
// `findMany` and nothing else, so adding a write is a compile error rather than
// a review miss. The ONE transaction this file opens is the read-only
// REPEATABLE READ snapshot both passes read through (see WHY BOTH PASSES RUN IN
// ONE SNAPSHOT below): because the only statements inside it are those
// `findMany` reads, it takes no row locks, blocks no writer and changes
// nothing — it exists to pin the state the two passes are reconciled against.
// Everything this stage does write goes to the FILESYSTEM: its publication
// lock, the staged artefacts and the committed pair it promotes them over.
//
// WHY IT RECORDS MEASUREMENTS AND NEVER POLICY. Every bound, category target,
// kcal review range and check name this report mentions is read from
// data/meal-planning/coverage-plan.v1.json (and the evidence allowlist version
// from data/meal-planning/evidence-allowlist.v1.json), reproduced under
// `boundsMeasuredAgainst` beside the `policySource` that owns it. A report that
// restated a bound as its own would become a second authority that drifts from
// the one the checks actually ran under, and the first symptom would be an
// audit that reads as consistent while measuring against the wrong number. The
// authoritative bound for any single observation is the one on that item's own
// check entry, written when the check ran.
//
// WHY THE TWO ARTEFACTS ARE RECONCILED BEFORE EITHER IS TRUSTED. The
// per-category quarantine figures appear in both files, and a quarantined row
// is excluded from every published count — so if the two disagree, one of them
// is understating or overstating the distance between the catalog and the plan,
// and a shortfall is the one number in this pipeline that must never be
// negotiable. The run therefore writes the validation report to a STAGING
// file, reads its quarantine block back off that file, compares it with the
// figures bound for the import report, and REFUSES to publish either artefact
// if they differ, naming both numbers. Inconsistent evidence is worse than
// none: it is wrong and it looks authoritative.
//
// WHY BOTH ARTEFACTS ARE STAGED AND PUBLISHED AS ONE SET. The pair is only
// evidence together: the aggregate figures in one are reconciled against the
// per-item records in the other, so a run that replaced the first file and
// then failed would leave a reconciled half beside an unreconciled half — or,
// worse, a validation report truncated mid-item that still looks like JSON to
// a reader who does not reach its end. Both documents are therefore written to
// hidden sibling staging files, checked for completeness, and renamed over
// their canonical paths back to back at the very end; any failure before that
// point discards the staging files and leaves the PREVIOUS pair exactly as it
// was. The whole run holds an exclusive publication lock on the output
// directory, so the import and generation stages — which own the other half of
// `import-report.json` — cannot write into it between this run's read of that
// file and its promotion of the merged result.
//
// WHY ONE PHYSICAL DIRECTORY IDENTITY RUNS THROUGH ALL OF IT. `--out` is an
// arbitrary operator path, and a path is not a place: a symlink on it can name
// one directory when a check runs and another when the rename happens. So the
// destination is resolved ONCE to its physical identity and that single value
// is what the scoped-report guard is evaluated against, what the publication
// lock is taken on, and what both artefact paths are built from — written
// through, never re-derived from the spelling. Publishing through an identity
// leaves nothing on the path to retarget; the remaining window, between
// resolving the destination and publishing into it, is closed by re-deriving
// the identity under the lock and refusing the run if it moved.
//
// AND WHY ONE CHECK UNDER THE LOCK IS NOT THE WHOLE STORY. An identity holds no
// symlink, but the DIRECTORY it names can still be unlinked and re-created as
// one, and the catalog measurement between the check and the publication is two
// awaited scans that take minutes on a full catalog. A principal who can plant
// a name in that directory's parent could therefore replace it while the scan
// runs, and every later use of the path — the staging writes, the read-back and
// the promotion — would follow the replacement while the publication lock was
// still keyed to the directory that had gone. Two things close that window, and
// neither is a second identity:
//
//   * the destination's parent is held to lib/manifest.ts's
//     `assertSafeArtifactParent`, so a parent another local principal can plant
//     a name in is refused before anything is read or published — the same rule
//     `catalog-release.ts` holds its release parent to;
//   * the publication directory's `(device, inode)` is captured under the lock
//     and re-verified immediately before EACH path-based operation that happens
//     after the awaited measurement. Node offers no descriptor-relative open
//     (no `openat`, no `mkdirat`, no `renameat`) and no way to hand a directory
//     handle to `fs.rename` or to a write stream, so this stage cannot hold the
//     directory as a capability and write through it. Revalidation immediately
//     before each use is the instrument that remains: it does not remove the
//     race, it reduces it to the two statements between the `lstat` and the
//     call it authorises, and it turns a redirected publication into a refusal.
//
// Both header reads are no-follow regular-file reads for the same reason: a
// document this stage reads is a document it makes a decision from, and a
// symlink planted at an artefact name would otherwise redirect that read.
//
// WHY BOTH PASSES RUN IN ONE SNAPSHOT. The aggregate figures come from one
// scan of `catalog_foods` and the per-item records from a second, and the two
// numbers they produce are reconciled against each other. Two passes over a
// catalog that a concurrent `catalog:load` or `catalog:validate` is changing
// would reconcile figures taken from two different states — the drift would be
// small, plausible and undetectable. `main()` therefore opens a REPEATABLE
// READ transaction and both passes read through it, and the run then asserts
// that the number of per-item records emitted equals the number of published
// rows the aggregate pass counted. The snapshot makes the two passes agree; the
// assertion is what proves they did.
//
// A shortfall against the 10,000 accepted-item requirement is reported exactly
// and stated as an unmet requirement. It is never rounded, smoothed against a
// surplus in another category, or estimated: reaching the target depends on the
// USDA rate limit, on model availability during generation and on identity
// evidence passing its checks, and any of those can legitimately fall short.
//
// The two guard imports are ordered and load-bearing: Rule
// backend-architecture §10's IPv4-first DNS ordering, then dbGuard's
// module-load classification of DATABASE_URL, both ahead of anything that
// could reach Prisma or the network. `src/prisma/client.ts` constructs its
// client at import, so this file reaches it through a dynamic import inside
// `main()` — importing this module must open no connection and start no run.
import './lib/bootstrap';
import './lib/dbGuard';

import { once } from 'events';
import fs from 'fs';
import path from 'path';

import { classifyDatabaseOrigin, DatabaseOriginError, originLogFields } from './lib/dbGuard';
import { createFatalLogger, createLogger, formatSafeError, isThrownInstanceOf, safeError, writeLineSync } from './lib/logger';
import type { LogFields, LogLevel, SafeErrorFields, ScriptLogger } from './lib/logger';
import {
    MERGED_REPORT_COMPOUND_BLOCKS,
    ManifestError,
    assertSafeArtifactParent,
    discardStagedArtifacts,
    loadCoveragePlan,
    loadEvidenceAllowlist,
    mergeStageReport,
    physicalPathIdentity,
    promoteStagedArtifacts,
    reportPath,
    stageJsonArtifact,
    stagingPathFor,
    withArtifactPublicationLock,
} from './lib/manifest';
import type { CatalogFoodState, CoveragePlan, StagedArtifact } from './lib/manifest';

// The decode half of the storage rule the validation record is written under:
// `nutrition_assumptions` is a JSON-encoded array in a TEXT column. Taken from
// the library the catalog stages share rather than re-implemented here, because
// a second decoder is a second rule that can drift from the encoder while still
// parsing (see lib/nutritionAssumptions.ts).
import { parseStoredAssumptions } from './lib/nutritionAssumptions';

// The RULES this report applies, none of them re-derived here: the shortfall
// arithmetic, the tier every check name carries, and the bound a category and
// food state resolve to (Rule backend-architecture §1.2 and §7 — pure
// functions decide, the aggregation loop and the file writing orchestrate).
// The closed value sets the aggregate counters are keyed by come from the same
// module for the same reason (see THE CLOSED VALUE SETS THE COUNTERS ARE KEYED
// BY): it is the one enforcement point for them, and a set restated here would
// be a second authority that can drift from the one the rows were written
// under.
import {
    CATALOG_CHECK_NAMES,
    CATALOG_QUARANTINE_CHECK_NAMES,
    CATALOG_REJECT_CHECK_NAMES,
    CATALOG_REVIEW_CHECK_NAMES,
    catalogCheckTier,
    computeCoverageShortfall,
    isCatalogFoodState,
    isCatalogIdentitySource,
    isCatalogIdentityStatus,
    isCatalogNutritionBasis,
    isCatalogNutritionProvenance,
    isCatalogPublicationStatus,
    resolveCategoryBounds,
} from '../src/services/catalog.logic';
import type { CatalogCheckName, CatalogCoverageShortfall, CatalogValidationPolicy } from '../src/services/catalog.logic';
// Type-only, for the one closed set `catalog.logic.ts` exports no guard for.
import type { CatalogValidationOutcome } from '../src/types/catalog';

const STAGE = 'catalog-report';

/** The §0.3.3 artefact names; `--out` overrides their directory, not their names. */
const VALIDATION_REPORT_FILE = 'validation-report.json';
const IMPORT_REPORT_FILE = 'import-report.json';

const REPORT_VERSION = 'v1';
const VALIDATION_REPORT_KIND = 'catalog-validation-evidence';

/**
 * The feature requirement — 10,000 distinct published, validated catalog items
 * (Agent Action Plan §0.1.1 requirement 3 and §0.7.3).
 *
 * This is NOT a policy bound and is deliberately the only count in this file
 * that is written rather than read: coverage-plan.v1.json owns the per-category
 * `publishedTarget` values and their 11,010 total, which carries slack over
 * this number precisely so late quarantines cannot put it at risk. The plan
 * does not carry the requirement itself, so it is named here, cited, and used
 * for one purpose — deciding whether the run reports a met requirement or an
 * unmet one.
 */
const REQUIRED_PUBLISHED_ITEMS = 10000;

/** Rows per database page. Bounds memory: a full catalog is ~12,000 rows whose
 * validation records serialise to tens of megabytes, so neither pass may hold
 * the whole set. */
const PAGE_SIZE = 500;

/**
 * The isolation both passes read through.
 *
 * REPEATABLE READ rather than SERIALIZABLE: the run only reads, so it needs a
 * stable snapshot and not conflict detection, and on PostgreSQL REPEATABLE
 * READ gives every statement in the transaction the same snapshot taken at the
 * first one — which is exactly the guarantee the aggregate pass and the
 * per-item pass need to be reconcilable. SERIALIZABLE would add
 * serialisation-failure retries to a read-only report for no benefit.
 *
 * Recorded in the artefact (`siblingReconciliation.validationReport`), so the
 * evidence states the condition under which its two halves were measured.
 */
export const REPORT_SNAPSHOT_ISOLATION = 'RepeatableRead';

/**
 * How long the snapshot may be held, and how long the run waits for a
 * connection to open it.
 *
 * The timeout has to cover BOTH passes and the serialisation of a
 * tens-of-megabytes document, because the per-item pass streams as it scans —
 * that interleaving is what bounds memory, and it is why the transaction spans
 * the write rather than only the reads. Thirty minutes is far beyond the
 * minute or two a full catalog takes and is a liveness bound, not a budget: a
 * run that hits it has lost its snapshot, and `report_snapshot_failed` says so
 * rather than letting two passes describe two states.
 */
const REPORT_SNAPSHOT_TIMEOUT_MS = 30 * 60 * 1000;
const REPORT_SNAPSHOT_MAX_WAIT_MS = 30 * 1000;

/** The publication status whose rows carry the per-item evidence records. */
const PUBLISHED = 'published';
const QUARANTINED = 'quarantined';
const REJECTED = 'rejected';
/** `catalog_foods.identity_source` for a row generation proposed. */
const AI_GENERATED_IDENTITY_SOURCE = 'ai_generated';
const CANDIDATE = 'candidate';

/**
 * The three statuses a row can hold that mean "the catalog withheld it", in the
 * order the audit reports them.
 *
 * `retired` is deliberately not one of them: a retired row WAS published by an
 * earlier release and is still referenceable, so filing it under "withheld"
 * would misreport a row that was never held back. It is counted per category on
 * every category row like the other statuses.
 */
const WITHHELD_STATUSES: readonly string[] = [CANDIDATE, QUARANTINED, REJECTED];

/**
 * The most identities the audit collects PER STATUS.
 *
 * A cap is needed because the identities are held in memory across the whole
 * scan, and a catalog that quarantined everything would otherwise size this
 * stage by the table rather than by the evidence. It is not a silent
 * truncation: the per-status totals beside the list are measured from every row
 * scanned, the cap itself is emitted as `identityCap`, and the number of
 * identities it left out is emitted as `identitiesOmittedByCap` in the same
 * block — so a reader can always tell a complete list from a capped one.
 */
const WITHHELD_IDENTITY_LIMIT = 5000;

/** Named because the read-back that reconciles the two artefacts slices the
 * document at exactly this key (see `reconcileQuarantineFigures`). */
const ITEMS_KEY = 'items';

const COVERAGE_PLAN_RELATIVE_PATH = 'data/meal-planning/coverage-plan.v1.json';
const EVIDENCE_ALLOWLIST_RELATIVE_PATH = 'data/meal-planning/evidence-allowlist.v1.json';
const CHECK_VOCABULARY_SOURCE = 'src/services/catalog.logic.ts CATALOG_CHECK_NAMES, with the tier of each in CHECK_TIERS';
const DATABASE_URL_ENV = 'DATABASE_URL';

const logger = createLogger(STAGE);

// ---------------------------------------------------------------------------
// Errors (Rule backend-architecture §8) — thrown from anywhere, mapped once, at
// main(), to an exit code. Nothing in this file catches to swallow.
// ---------------------------------------------------------------------------

export type CatalogReportErrorCode =
    | 'missing_validation_record'
    | 'quarantine_reconciliation_failed'
    | 'unknown_category_filter'
    | 'scoped_report_needs_out_dir'
    | 'report_unreadable'
    /**
     * A row holds a value in a closed-set column that the set does not declare,
     * so a counter keyed on that column would file it under an unvalidated
     * string (see {@link assertRecognisedStoredValues}).
     */
    | 'unrecognised_stored_value'
    /**
     * The per-item records emitted do not number what the aggregate pass
     * measured. Under one snapshot the two passes see one catalog, so a
     * disagreement means the report is not describing a single state — and a
     * report that states one published total and evidences a different number
     * of items is exactly the artefact a reviewer cannot use.
     */
    | 'item_count_mismatch'
    /**
     * The snapshot the two passes share could not be opened or could not be
     * held for the whole run (a transaction timeout, a lost connection). The
     * run produces nothing rather than two passes over two different states.
     */
    | 'report_snapshot_failed'
    /**
     * The output directory this run resolved is no longer the same physical
     * directory it was when the destination was decided: a symlink on the path
     * was retargeted, or the directory itself was replaced, between the guard
     * and the publication.
     *
     * Reported rather than followed. The two artefacts are whole-catalog
     * acceptance evidence, and the one thing a run must never do is write them
     * somewhere other than the place whose suitability was checked — the
     * scoped-report guard, the publication lock and both writes are only
     * meaningful if they are about ONE directory (CWE-59, CWE-367).
     */
    | 'output_directory_changed';

export class CatalogReportError extends Error {
    constructor(
        message: string,
        public readonly code: CatalogReportErrorCode,
    ) {
        super(message);
        this.name = 'CatalogReportError';
    }
}

// ---------------------------------------------------------------------------
// Argument parsing — pure (Rule backend-architecture §1.2).
// ---------------------------------------------------------------------------

export interface ReportOptions {
    readonly help: boolean;
    /** `--category`; `null` reports the whole catalog. */
    readonly category: string | null;
    /**
     * `--out`; `null` means the default report directory. A relative value is
     * resolved against the backend package root by `resolveOutDir` below, so
     * the same command writes the same files from any working directory.
     */
    readonly out: string | null;
}

export interface ArgumentError {
    readonly flag: string;
    readonly message: string;
}

export type ParseResult =
    | { readonly ok: true; readonly options: ReportOptions }
    | { readonly ok: false; readonly errors: readonly ArgumentError[] };

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
        return { ok: true, options: { help: true, category: null, out: null } };
    }

    const errors: ArgumentError[] = [];
    let category: string | null = null;
    let categorySeen = false;
    let out: string | null = null;
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

        if (flag === '--category') {
            const value = takeValue(inlineValue);
            if (value === null) {
                errors.push({ flag, message: `${flag} requires a coverage-plan category code` });
                continue;
            }
            if (categorySeen) {
                errors.push({ flag, message: `${flag} was given more than once; it takes a single value` });
                continue;
            }
            categorySeen = true;
            category = value;
            continue;
        }

        if (flag === '--out') {
            const value = takeValue(inlineValue);
            if (value === null) {
                errors.push({ flag, message: `${flag} requires a directory path` });
                continue;
            }
            if (outSeen) {
                errors.push({ flag, message: `${flag} was given more than once; it takes a single value` });
                continue;
            }
            outSeen = true;
            out = value;
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

    return { ok: true, options: { help: false, category, out } };
};

// ---------------------------------------------------------------------------
// Usage.
// ---------------------------------------------------------------------------

export const describeUsage = (): string =>
    [
        `Usage: npm run catalog:report -- [options]   (${STAGE})`,
        '',
        'Reads catalog_foods and catalog_validation_records and writes the catalog',
        'evidence artefacts. Read-only: no catalog row is created, updated or deleted.',
        '',
        'Options:',
        '  --category <code>  Report one coverage-plan category instead of the whole',
        '                     catalog. A scoped report is partial evidence, so it',
        '                     requires an --out directory OUTSIDE the committed report',
        '                     directory: the run is refused when its output resolves to',
        '                     that directory or inside it, whether --out was omitted or',
        '                     pointed there explicitly.',
        '  --out <dir>        Write the artefacts to this directory instead of the',
        '                     default. A relative path resolves against the backend',
        '                     package root, and symlinks are resolved before the',
        '                     scoped-report check above.',
        `                     Default: data/meal-planning/reports/latest`,
        '  --help, -h         Print this usage block and exit 0.',
        '',
        'Artefacts written:',
        `  ${VALIDATION_REPORT_FILE}   one validation record per published food, the`,
        '                             three-tier rollup and the per-category',
        '                             quarantine counts',
        `  ${IMPORT_REPORT_FILE}       the aggregate half only — counts, duplicates,`,
        '                             quarantine, coverage gaps and the exact',
        "                             shortfall. The import stage's own fields are",
        '                             merged into, never overwritten',
        '',
        'How they are written:',
        '  Both documents are staged beside their canonical paths, reconciled against',
        '  each other, and then renamed into place back to back, holding an exclusive',
        '  publication lock on the output directory. A failure at any point leaves the',
        '  previous pair exactly as it was, so a failed run produces no evidence rather',
        '  than half-replaced evidence. Both passes over catalog_foods read through one',
        `  ${REPORT_SNAPSHOT_ISOLATION} snapshot, and the run refuses to publish unless the number of`,
        '  per-item records equals the number of published rows it counted.',
        '',
        'Inputs read:',
        `  ${COVERAGE_PLAN_RELATIVE_PATH}   the per-category published`,
        '                                             targets every shortfall is',
        '                                             measured against, the check',
        '                                             vocabulary and the bounds',
        `  ${EVIDENCE_ALLOWLIST_RELATIVE_PATH}   the allowlist version the`,
        '                                                identity evidence was',
        '                                                retrieved under',
        '',
        'Environment:',
        `  ${DATABASE_URL_ENV}   required; classified by scripts/lib/dbGuard.ts. The counts`,
        '                 come from catalog_foods and catalog_validation_records in it.',
    ].join('\n');

const writeUsage = (level: LogLevel): void => {
    writeLineSync(describeUsage(), level);
};

/**
 * Where the artefacts are written. `null` takes the directory manifest.ts
 * validates for the committed artefacts; an operator value is resolved against
 * the backend package root so the command is working-directory independent.
 */
export const resolveOutDir = (out: string | null): string =>
    out === null ? path.dirname(reportPath(VALIDATION_REPORT_FILE)) : path.resolve(__dirname, '..', out);

/** The directory holding the committed whole-catalog artefacts. */
export const canonicalReportDirectory = (): string => path.dirname(reportPath(VALIDATION_REPORT_FILE));

/**
 * Resolves `absolutePath` through any symlink on it, as far as the path exists
 * — the identity every comparison and every write in this stage is about.
 *
 * Needed because the scoped-report guard below compares two directories, and a
 * lexical comparison alone can be walked around: a symlink, a bind mount or a
 * case-insensitive filesystem can name the committed report directory without
 * spelling it. Resolution stops at the deepest ancestor that exists and the
 * remaining segments are appended lexically, so the guard also works for an
 * `--out` directory the run has not created yet.
 *
 * Delegates to manifest.ts's `physicalPathIdentity` rather than resolving here.
 * The publication lock keys mutual exclusion on THAT function's answer, so a
 * second resolver in this file — however faithful today — would be a second
 * authority able to drift from the one the lock uses, which is the precise
 * shape of the bug this stage now refuses: a directory that was validated
 * under one identity and written under another. Kept as a named export because
 * the guard below reads as a comparison of DIRECTORIES, and because
 * `src/__tests__/scripts/` pins the resolution rule through this name.
 */
export const canonicalizeDirectoryPath = (absolutePath: string): string => physicalPathIdentity(absolutePath);

/**
 * Whether `resolvedOutDir` IS the canonical report directory or sits inside it.
 *
 * Pure: both paths are arguments, already absolute and already resolved
 * through their symlinks by the caller, so this decision is pinned by
 * `src/__tests__/scripts/` without touching a filesystem (Rule
 * backend-architecture §1.2, §11).
 */
export const writesIntoCanonicalReportDirectory = (resolvedOutDir: string, canonicalDir: string): boolean => {
    const out = path.resolve(resolvedOutDir);
    const canonical = path.resolve(canonicalDir);
    if (out === canonical) {
        return true;
    }
    const relative = path.relative(canonical, out);
    return relative !== '' && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative);
};

/**
 * The refusal a `--category` run earns when its artefacts would land on the
 * committed whole-catalog pair, or `null` when the output directory is safe.
 *
 * A scoped run measures ONE category: its `coverage`, `requirement`,
 * `shortfall` and per-item records cover that category alone. Published at the
 * canonical paths those figures would read exactly like whole-catalog evidence
 * — same file names, same shape, same `reportVersion` — while understating the
 * catalog by every other category. So the destination is checked, not merely
 * the presence of the flag: omitting `--out` and passing the canonical
 * directory as `--out` produce the same artefacts in the same place, and a
 * guard that only asks whether the flag was given refuses one and waves the
 * other through.
 */
export const scopedReportRefusal = (input: {
    readonly category: string;
    readonly out: string | null;
    readonly resolvedOutDir: string;
    readonly canonicalReportDir: string;
}): string | null => {
    if (!writesIntoCanonicalReportDirectory(input.resolvedOutDir, input.canonicalReportDir)) {
        return null;
    }

    const destination =
        input.out === null ? 'the default report directory' : `--out ${input.out} (resolved to ${input.resolvedOutDir})`;

    return (
        `--category ${input.category} produces partial evidence, so it must not be written to the committed report ` +
        `directory ${input.canonicalReportDir}. This run would write it there through ${destination}, replacing the ` +
        `whole-catalog ${VALIDATION_REPORT_FILE} and the aggregate half of ${IMPORT_REPORT_FILE} with a single ` +
        "category's figures under the same file names. Pass --out <dir> pointing outside that directory."
    );
};

// ---------------------------------------------------------------------------
// ONE OUTPUT DIRECTORY, FROM THE GUARD TO THE RENAME.
//
// The destination is decided once, as a PHYSICAL IDENTITY, and that single
// value is what the scoped-report guard is evaluated against, what the
// publication lock is taken on, what both artefact paths are built from and
// what the run logs. The bug this closes had the guard consider the resolved
// directory while the lock and the writes used the operator's spelling: a
// symlink on that spelling could be pointed at a harmless directory while the
// guard ran and retargeted at data/meal-planning/reports/latest before the
// renames, so a single category's figures replaced whole-catalog acceptance
// evidence under the same file names, and the lock — keyed on the identity it
// was handed — serialised a directory nobody was writing to (CWE-59, CWE-367).
//
// Writing THROUGH the identity is what makes a later retarget inert: the
// identity holds no symlink, so there is nothing left on the path to retarget.
// The checks below cover what remains — the directory itself being replaced,
// and the window between deciding the destination and publishing into it.
// ---------------------------------------------------------------------------

/**
 * The refusal a run earns when the directory it resolved is no longer the same
 * physical place, or `null` when both later observations still agree with the
 * identity the destination was decided as.
 *
 * TWO observations rather than one, because two different things can change:
 *
 *   * `observedFromNamedPath` re-resolves the path as the OPERATOR spelled it.
 *     It diverges when a symlink on that spelling has been retargeted — the
 *     original attack. Nothing was redirected (the writes go through
 *     `expected`), but the operator named a place this run is no longer about,
 *     and publishing evidence to a directory they did not mean is the mistake.
 *   * `observedFromIdentity` re-resolves the identity itself. It diverges when
 *     the resolved directory has been replaced — unlinked and re-created as a
 *     symlink, say — which WOULD redirect a write that followed it.
 *
 * Pure, so both failure modes are pinned by `src/__tests__/scripts/` without a
 * filesystem: the caller takes the observations and this function decides
 * (Rule backend-architecture §1.2, §11).
 */
export const publicationDirectoryDriftRefusal = (input: {
    readonly named: string;
    readonly expected: string;
    readonly observedFromNamedPath: string;
    readonly observedFromIdentity: string;
}): string | null => {
    const divergence =
        input.observedFromNamedPath !== input.expected
            ? { through: `the path this run was given (${input.named})`, observed: input.observedFromNamedPath }
            : input.observedFromIdentity !== input.expected
              ? { through: 'the resolved output directory itself', observed: input.observedFromIdentity }
              : null;

    if (divergence === null) {
        return null;
    }

    return (
        `the output directory changed identity while this run was preparing to publish: ${divergence.through} now ` +
        `resolves to ${divergence.observed}, and the destination this run checked, locked and built its artefact ` +
        `paths from is ${input.expected}. Nothing was written, so the previous ${VALIDATION_REPORT_FILE} and ` +
        `${IMPORT_REPORT_FILE} are intact. A symlink on the output path was retargeted or the directory was ` +
        'replaced; confirm what the path points at and run the stage again.'
    );
};

/**
 * The publication directory as the KERNEL identifies it, rather than as a path
 * resolves: the device and inode of the entry AT that name.
 *
 * `physicalPathIdentity` answers "which place does this spelling mean", which is
 * the question the guard, the lock and the artefact paths are built on. This
 * answers the different question the post-measurement checks need: "is the
 * directory still the same OBJECT it was", which a re-resolution cannot see —
 * a directory unlinked and re-created, or replaced by a link that points back
 * at an equal-looking path, resolves to the same string and is not the same
 * directory.
 */
export interface PublicationDirectoryIdentity {
    readonly device: number;
    readonly inode: number;
}

/**
 * The identity of the real directory at `directory`, or `null` when that name
 * does not hold one — a symbolic link (however it resolves), a file, or nothing
 * at all.
 *
 * `lstat` rather than `stat`, because what a caller is deciding about is the
 * ENTRY at this name: a link that resolves to a perfectly good directory is
 * still a redirected publication, and `stat` would report the target and agree.
 *
 * Every unreadable outcome collapses to `null` and is logged with its errno:
 * absent, not-a-directory and unreadable are one answer for the caller — "this
 * is not the directory the run captured" — and the refusal that follows names
 * the path, so the log line is where an unexpected errno stays visible.
 */
const observePublicationDirectory = (
    directory: string,
    logger: ScriptLogger,
): PublicationDirectoryIdentity | null => {
    let stats: fs.Stats;
    try {
        stats = fs.lstatSync(directory);
    } catch (error) {
        logger.warn('publication_directory_unidentified', {
            stage: STAGE,
            outDir: directory,
            error: safeError(error),
            consequence:
                'The output directory could not be identified, so this run cannot establish that it is still ' +
                'publishing into the directory it locked and refuses instead.',
        });
        return null;
    }

    if (!stats.isDirectory()) {
        logger.warn('publication_directory_replaced', {
            stage: STAGE,
            outDir: directory,
            entryIsSymbolicLink: stats.isSymbolicLink(),
            consequence:
                'The output directory name no longer holds a directory, so a write through it would land somewhere ' +
                'this run never checked.',
        });
        return null;
    }

    return { device: stats.dev, inode: stats.ino };
};

/**
 * The refusal a run earns when the publication directory is no longer the
 * directory whose identity it captured, or `null` when it still is.
 *
 * The sibling of {@link publicationDirectoryDriftRefusal}, and the reason there
 * are two: that one compares RESOLUTIONS, which catches a retargeted symlink on
 * the output path, and this one compares the `(device, inode)` of the directory
 * OBJECT, which is the only thing that catches the directory itself being
 * swapped for another one — including a swap for a directory whose path
 * resolves to the same spelling. It is called immediately before each
 * path-based operation that follows the awaited catalog measurement, so
 * `operation` names the act the verdict authorises and the refusal can say what
 * did not happen.
 *
 * Pure: the caller takes the observation and this function decides, so both
 * verdicts are pinned by `src/__tests__/scripts/` without a filesystem (Rule
 * backend-architecture §1.2, §11).
 */
export const publicationDirectoryReplacedRefusal = (input: {
    readonly directory: string;
    readonly operation: string;
    readonly expected: PublicationDirectoryIdentity;
    readonly observed: PublicationDirectoryIdentity | null;
}): string | null => {
    if (
        input.observed !== null &&
        input.observed.device === input.expected.device &&
        input.observed.inode === input.expected.inode
    ) {
        return null;
    }

    const holdsNow =
        input.observed === null
            ? 'no directory at all'
            : `a different directory (device ${input.observed.device}, inode ${input.observed.inode} rather than ` +
              `device ${input.expected.device}, inode ${input.expected.inode})`;

    return (
        `${input.directory} is no longer the directory this run locked and measured the catalog for, so ` +
        `${input.operation} did not happen and the previous ${VALIDATION_REPORT_FILE} and ${IMPORT_REPORT_FILE} are ` +
        `intact. The name now holds ${holdsNow}. Something replaced the output directory while the report was being ` +
        `produced: check who can write to ${path.dirname(input.directory)}, then run the stage again.`
    );
};

/** The one directory a run publishes into, and what was decided about it. */
export interface ReportOutputDirectory {
    /** The operator's own spelling, resolved to an absolute path. Named in
     * messages and logs, never written through. */
    readonly named: string;
    /** The physical identity the guard, the lock and both writes all use. */
    readonly directory: string;
    /** The identity of the committed whole-catalog report directory. */
    readonly canonicalReportDir: string;
    /** Whether this run publishes the committed artefacts (or something inside
     * that directory) — stated in the invocation log so the operator can see
     * which artefacts a run is about to replace. */
    readonly writesCommittedArtefacts: boolean;
}

/**
 * Decides the destination, once, and returns the identity everything
 * downstream uses.
 *
 * The ORDER of the four steps is the contract:
 *
 *  1. Resolve the identity WITHOUT creating anything, and evaluate the
 *     scoped-report guard on it. A refused run must not leave a directory
 *     behind at a path it just refused to publish into.
 *  2. Create the destination's PARENT, and refuse a parent another local
 *     principal can plant a name in. That right is what a later replacement of
 *     the output directory needs, and it is the one thing no check downstream
 *     of here can take away — so it is refused before the destination exists,
 *     which also keeps step 1's promise for this refusal too.
 *  3. Create the directory. `physicalPathIdentity` appends a not-yet-existing
 *     tail lexically, and this stage creates the directory anyway (the sink and
 *     the lock both `mkdir` it); creating it here is what makes the identity
 *     EXACT for the guard, the lock and the paths rather than part-lexical.
 *  4. Re-resolve and refuse on drift. Steps 1 and 3 are two moments, and a
 *     symlink planted at the output name in between would make the directory
 *     that now exists a different place from the one the guard passed. Refusing
 *     is the only answer that keeps the guarantee this function exists for.
 *
 * Throws `CatalogReportError` and never a bare string, so `main()`'s single
 * error mapping reports it with a code an operator can act on (Rule
 * backend-architecture §8) — except the parent refusal, which is
 * lib/manifest.ts's `ManifestError` and is reported by `main()` through the
 * same single mapping (`describeFailure`) under its own
 * `unsafe_artifact_directory` code.
 */
export const resolveReportOutputDirectory = (input: {
    readonly options: ReportOptions;
    readonly logger: ScriptLogger;
}): ReportOutputDirectory => {
    const named = resolveOutDir(input.options.out);
    const directory = physicalPathIdentity(named);
    const canonicalReportDir = physicalPathIdentity(canonicalReportDirectory());

    if (input.options.category !== null) {
        // Omitting `--out` and passing the committed directory as `--out`
        // produce the same partial artefacts in the same place, so both are
        // refused: a guard that only asked whether the flag was given would
        // wave the explicit form through.
        const refusal = scopedReportRefusal({
            category: input.options.category,
            out: input.options.out,
            resolvedOutDir: directory,
            canonicalReportDir,
        });
        if (refusal !== null) {
            throw new CatalogReportError(refusal, 'scoped_report_needs_out_dir');
        }
    }

    try {
        // The PARENT first, and the destination after the refusal below, both
        // at the IDENTITY rather than at the spelling: every component of the
        // identity that existed at resolution is a real directory, so neither
        // create can be diverted by a symlink on an ancestor of the operator's
        // path. `--out` legitimately names a directory whose parent this run is
        // the first to make, which is why the parent is created rather than
        // required.
        fs.mkdirSync(path.dirname(directory), { recursive: true });
    } catch (error) {
        // Logged rather than thrown: the refusal below reports a parent that is
        // not there, and it names both the parent and the destination, which is
        // the more useful message.
        input.logger.warn('out_dir_parent_not_created', {
            stage: STAGE,
            outDir: directory,
            parent: path.dirname(directory),
            error: safeError(error),
            consequence:
                'The parent of the output directory could not be created, so the destination cannot be established ' +
                'as one no other local principal can plant a name in.',
        });
    }

    // THE CAPABILITY THE LATER RACE NEEDS, REFUSED HERE. Everything downstream
    // protects the identity of this directory; nothing downstream can stop
    // another local principal from REPLACING it, because replacing a name is a
    // right the name's parent grants. So the parent is held to the pipeline's
    // one definition of a publishable parent — a real directory, not a link,
    // that no other principal may plant a name in — which is the same rule
    // `catalog-release.ts` holds its release parent to, through the same
    // helper.
    //
    // Before the destination is created, so a run refused by this rule leaves
    // nothing behind at the name it refused to publish into.
    assertSafeArtifactParent(directory);

    try {
        fs.mkdirSync(directory, { recursive: true });
    } catch (error) {
        // Logged rather than thrown: the write that needs this directory is
        // about to attempt it too, and its failure names the artefact as well
        // as the directory, which is the more useful message. The identity
        // stays part-lexical here, and the drift check below still compares
        // like for like.
        input.logger.warn('out_dir_not_created', {
            stage: STAGE,
            outDir: directory,
            error: safeError(error),
            consequence:
                'The output directory could not be created here, so the publication attempt will report the ' +
                'failure against the artefact it could not write.',
        });
    }

    const drift = publicationDirectoryDriftRefusal({
        named,
        expected: directory,
        observedFromNamedPath: physicalPathIdentity(named),
        observedFromIdentity: physicalPathIdentity(directory),
    });
    if (drift !== null) {
        throw new CatalogReportError(drift, 'output_directory_changed');
    }

    return {
        named,
        directory,
        canonicalReportDir,
        writesCommittedArtefacts: writesIntoCanonicalReportDirectory(directory, canonicalReportDir),
    };
};

// ---------------------------------------------------------------------------
// Determinism helpers.
//
// A rerun against unchanged data must produce byte-identical artefacts, so a
// diff in review means the catalog changed and nothing else. Two things would
// break that: key order that follows insertion (which follows row order) and a
// comparator that follows the host locale. Every map this report emits goes
// through `sortedRecord`, every array is sorted on a stated key, and the
// comparator below compares code units rather than calling localeCompare.
// ---------------------------------------------------------------------------

export const compareStrings = (left: string, right: string): number => (left < right ? -1 : left > right ? 1 : 0);

// ---------------------------------------------------------------------------
// Key safety — every map in this file is keyed by DATA.
//
// THE DEFECT THIS CLOSES (CWE-1321). Almost every figure in the two artefacts
// is a counter keyed by a string read out of `catalog_foods` or
// `catalog_validation_records`: a check name, a category, a publication status,
// an identity source. Accumulated into a plain `{}`, those keys reach
// `Object.prototype` by two routes, and both of them were live here:
//
//   * THROUGH THE READ. `publishedChecks[check.name] ?? { evaluated: 0, … }`
//     answers `Object.prototype` for a row whose check is named `__proto__`,
//     and the `Object` function itself for one named `constructor`, because the
//     lookup walks the prototype chain. The `??` therefore never fires, and the
//     `tally.evaluated += 1` that follows writes the counter ONTO
//     `Object.prototype`, where every object in the process inherits it —
//     including the objects this run is serialising as evidence.
//   * THROUGH THE WRITE. `counts['__proto__'] = n` on a plain object invokes
//     the inherited `__proto__` setter instead of creating a property, so the
//     count silently vanishes: a report that omits rows it scanned while
//     reading as a complete measurement.
//
// So no map in this file whose keys are data is a plain `{}`. Each is created
// by {@link emptyCounts} or {@link emptyIndex} with NO prototype at all, which
// removes both routes at once: there is no inherited `__proto__` accessor to
// invoke and nothing to inherit a value from, so every key — the three
// reserved names included — behaves as the ordinary own data property the
// measurement means it to be.
//
// WHY NOT A `Map`. These maps ARE the artefacts: they are handed to
// `JSON.stringify`, and a `Map` serialises to `{}` — an evidence file whose
// every counter block is empty. A prototype-free object serialises exactly as a
// plain one does, so the published documents are byte-identical to what this
// stage wrote before. A `Map` is used only where the accumulator never leaves
// the function that builds it (`withheldCollected`, `publishedIdentities`).
//
// WHY THE READS GO THROUGH `ownValue`/`ownCount` AS WELL. The prototype-free
// maps above are the ones this file builds; the exported pure functions are
// also handed records built elsewhere — by a sibling stage, by the JSON already
// on disk, by a test — and a plain `{}` from one of those callers answers
// `constructor` with the `Object` function and would turn it into a count. An
// own-property read is the only lookup that states what a record itself says.
// ---------------------------------------------------------------------------

/** A map with no prototype, for keys that come from the data. */
const emptyIndex = <T>(): Record<string, T> => Object.create(null) as Record<string, T>;

/** {@link emptyIndex} for the counters, which is most of them. */
const emptyCounts = (): Record<string, number> => emptyIndex<number>();

/**
 * The value a record states AT `key` itself, never one it inherits.
 *
 * `Object.prototype.hasOwnProperty.call` rather than `record.hasOwnProperty`:
 * the record may itself be prototype-free, in which case it has no
 * `hasOwnProperty` method to call.
 */
const ownValue = <T>(record: Readonly<Record<string, T>>, key: string): T | undefined =>
    Object.prototype.hasOwnProperty.call(record, key) ? record[key] : undefined;

/** {@link ownValue} for a counter: a key the record does not state is a zero. */
const ownCount = (record: Readonly<Record<string, number>>, key: string): number => ownValue(record, key) ?? 0;

/**
 * A prototype-free copy of a record this stage did not build — the artefact
 * already on disk, a JSONB column.
 *
 * `JSON.parse` produces `__proto__` as an ORDINARY own property, so a document
 * carrying one survives the parse intact and then re-enters the prototype
 * chain the moment its keys are copied into a plain object with `[]=`, where
 * the key is dropped instead of preserved. Copying into a prototype-free
 * target keeps every key an own property, which is exactly what the merges
 * below promise: the keys this stage does not own survive as found.
 */
const copyOwnEntries = <T>(source: Readonly<Record<string, T>>): Record<string, T> => {
    const copy = emptyIndex<T>();
    for (const key of Object.keys(source)) {
        copy[key] = source[key];
    }
    return copy;
};

const sortedRecord = <T>(record: Readonly<Record<string, T>>): Record<string, T> => {
    const sorted = emptyIndex<T>();
    for (const key of Object.keys(record).sort(compareStrings)) {
        sorted[key] = record[key];
    }
    return sorted;
};

/**
 * Adds to the counter at `key`.
 *
 * Every counter this is called on comes from {@link emptyCounts}, and it has to:
 * the own-property read below makes the LOOKUP state only what the record
 * itself says, but the assignment that follows is what needs the prototype-free
 * target — `record['__proto__'] = n` on a plain object would invoke the
 * inherited setter and drop the count rather than record it.
 */
const increment = (record: Record<string, number>, key: string, by = 1): void => {
    record[key] = ownCount(record, key) + by;
};

/** Thousands separators without `toLocaleString`, whose output is locale-dependent. */
export const formatCount = (value: number): string => value.toFixed(0).replace(/\B(?=(\d{3})+(?!\d))/g, ',');

const asRecord = (value: unknown): Record<string, unknown> | null =>
    typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;

const asArray = (value: unknown): readonly unknown[] => (Array.isArray(value) ? value : []);

const snakeToCamel = (key: string): string => key.replace(/_([a-z0-9])/g, (_match, character: string) => character.toUpperCase());

/**
 * snake_case JSONB keys → camelCase, recursively.
 *
 * The database holds `canonical_identity`, `portion_units`, `identity_evidence`
 * and `checks` in the storage casing, and the wire side of this contract is
 * camelCase; `itemRecords.casing` in the artefact states that the translation
 * happens here and only here. VALUES are never touched, so `published`,
 * `source_backed`, `produce_vegetable`, `as_purchased` and `missing_gram_weight`
 * stay greppable against both the database and the release JSONL.
 */
export const camelizeKeys = (value: unknown): unknown => {
    if (Array.isArray(value)) {
        return value.map((entry) => camelizeKeys(entry));
    }
    const record = asRecord(value);
    if (record === null) {
        return value;
    }
    // Prototype-free: the keys are whatever the JSONB column holds, and a
    // stored `__proto__` key written into a plain object would set that
    // object's prototype instead of appearing on the item record — dropping a
    // field from the per-item evidence rather than carrying it.
    const camelized = emptyIndex<unknown>();
    for (const key of Object.keys(record)) {
        camelized[snakeToCamel(key)] = camelizeKeys(record[key]);
    }
    return camelized;
};

const isoDate = (value: Date | string): string => (typeof value === 'string' ? value : value.toISOString());

// ---------------------------------------------------------------------------
// The database seam.
//
// `findMany` and nothing else: this stage is read-only, and a type that cannot
// express a write is a stronger guarantee than a comment asking for one. The
// rows are declared in the storage casing because that is what Prisma returns;
// the camelCase translation happens at the artefact boundary above.
// ---------------------------------------------------------------------------

export interface ValidationRecordRow {
    readonly canonical_identity: unknown;
    readonly aliases: readonly string[];
    /**
     * The five identity and provenance columns the validation record mirrors
     * from its food. Read so the item records can carry the record's own copy —
     * the copy the checks ran against — and so a disagreement with the food row
     * is measured rather than hidden by reading only one of the two
     * (`integrityReconciliation.recordFieldMismatches`).
     */
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
    readonly reviewed_at: Date | string;
    readonly publication_status: string;
    readonly source_versions: unknown;
}

export interface ReportFoodRow {
    readonly source_key: string;
    readonly canonical_name: string;
    readonly display_name: string;
    readonly category: string;
    readonly food_state: string;
    readonly identity_source: string;
    readonly identity_status: string;
    readonly nutrition_provenance: string;
    readonly nutrition_basis: string;
    /**
     * Read for the same reason `nutrition_basis` is: the two together are what
     * decide whether the per-100 g normalisation had any arithmetic to do, and
     * therefore whether `invalid_basis_amount` and `non_finite_computed_value`
     * could have been recorded on this row at all (see
     * {@link notApplicableChecksForItem}).
     */
    readonly basis_amount: number;
    readonly publication_status: string;
    readonly food_group: string;
    readonly usda_data_type: string | null;
    readonly catalog_validation_records: ValidationRecordRow | null;
    /**
     * The row's component count, measured rather than inferred from
     * `nutrition_provenance`: the component checks
     * (`empty_component_set`, `invalid_component_quantity`) are recorded only
     * where a component set was derived, and "this food declares no components"
     * is a fact about the table, not about the provenance label.
     */
    readonly _count: { readonly catalog_food_components: number };
}

/**
 * The slice of the Prisma client this stage may use: `catalog_foods.findMany`
 * and nothing else. Narrowing the client at the type level is what makes the
 * read-only promise in this file's header enforceable — a write is a compile
 * error, not something a reviewer has to notice.
 *
 * No owner predicate appears in any query here, and that is deliberate rather
 * than an oversight of backend-architecture §5.1: `catalog_foods` and
 * `catalog_validation_records` are shared reference data with no `user_id`
 * column by design (§0.5.1 — "the only authenticated reads without a tenant
 * predicate"), so there is no owner key to scope by. What stands in its place
 * is `lib/dbGuard`, which classified `DATABASE_URL` at module load and refuses
 * an unrecognised origin, so this stage cannot be pointed at a database whose
 * provenance is unknown.
 */
export interface ReportDb {
    catalog_foods: {
        findMany(args: unknown): Promise<ReportFoodRow[]>;
    };
}

const FOOD_SELECTION = {
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
    publication_status: true,
    food_group: true,
    usda_data_type: true,
    _count: { select: { catalog_food_components: true } },
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
        },
    },
} as const;

/**
 * Pages every row the scope covers in `source_key` order, handing each page to
 * `consume`.
 *
 * Keyset pagination on the unique `source_key` rather than `skip`/`take`: the
 * order is the one the artefacts sort by, and a keyset cursor cannot skip or
 * repeat a row the way an offset can when rows are inserted between pages.
 */
const forEachFoodPage = async (
    db: ReportDb,
    where: Record<string, unknown>,
    consume: (rows: readonly ReportFoodRow[]) => void | Promise<void>,
): Promise<void> => {
    let cursor: string | null = null;

    for (;;) {
        const rows = await db.catalog_foods.findMany({
            where,
            select: FOOD_SELECTION,
            orderBy: { source_key: 'asc' },
            take: PAGE_SIZE,
            ...(cursor === null ? {} : { cursor: { source_key: cursor }, skip: 1 }),
        });

        if (rows.length === 0) {
            return;
        }

        await consume(rows);

        if (rows.length < PAGE_SIZE) {
            return;
        }
        cursor = rows[rows.length - 1].source_key;
    }
};

// ---------------------------------------------------------------------------
// Measurement — pass one.
// ---------------------------------------------------------------------------

export interface CheckTally {
    tier: string;
    evaluated: number;
    passed: number;
    failed: number;
}

export interface QuarantinedIdentity {
    readonly sourceKey: string;
    readonly category: string;
    readonly foodState: string;
    readonly displayName: string;
    readonly identitySource: string;
    readonly outcome: string | null;
    /** The failed check names, sorted — the index into the evidence below. */
    readonly failingChecks: readonly string[];
    /**
     * The same failures with their observed value and bound, so the reason this
     * row was withheld is readable without re-running the validator. Names
     * sorted identically to {@link failingChecks}, and the audit asserts the two
     * state the same set.
     */
    readonly failingCheckEvidence: readonly WithheldCheckEvidence[];
}

/**
 * One withheld row's identity, for any of the three statuses that mean the
 * catalog did not publish it.
 *
 * The same fields as a quarantined identity plus the status itself, because the
 * audit lists all three together and "what was withheld and why" is unanswerable
 * without saying which kind of withholding it was: a candidate is awaiting a
 * judgement, a quarantined row is unusable until more data arrives, and a
 * rejected row is never publishable. {@link CatalogMeasurement.quarantinedIdentities}
 * is a VIEW of this one collection rather than a second pass over the rows, so
 * the quarantine block and the audit can never disagree about the same row.
 */
export interface WithheldIdentity extends QuarantinedIdentity {
    readonly publicationStatus: string;
}

/* ---------------------------------------------------------------------------
 * WHETHER GENERATED CONTENT REACHED THE CATALOG, MEASURED
 *
 * `dataProvenance` carries a legal determination about the USDA data, which is
 * why it is preserved rather than rewritten. Two of its keys are not legal
 * facts though: one ASSERTS that no generated content is present and the other
 * explains it with "no generation ran for this catalog". A generation stage
 * that has since run writes its own counters into the same artefact, so those
 * two sentences can end up standing beside 157 executed batches and several
 * hundred generated rows and flatly contradicting them.
 *
 * So the question is measured instead, on both sides of the publication line:
 * how many generated identities are PUBLISHED (the number that decides whether
 * anything needs the estimate labelling the Agent Action Plan §0.7.3 requires),
 * and how many were generated and WITHHELD, by the status withholding them.
 * Zero published with hundreds withheld is a meaningful, checkable statement;
 * "no generation ran" is neither, once one has.
 * ------------------------------------------------------------------------- */

export interface GeneratedContentPresence {
    readonly publishedGeneratedFoods: number;
    readonly withheldGeneratedRowsByStatus: Readonly<Record<string, number>>;
    readonly withheldGeneratedRowsTotal: number;
    readonly measuredFrom: string;
    readonly labellingConsequence: string;
    readonly statement: string;
}

/**
 * Generated identities either side of the publication line.
 *
 * Pure, so the statement can be pinned by a unit test: it is the sentence a
 * reader will take as the artefact's answer on whether an AI estimate is in
 * front of a user.
 *
 * WHY IT TAKES COUNTERS AND NOT THE IDENTITY LIST. The withheld identity list
 * is CAPPED at {@link WITHHELD_IDENTITY_LIMIT} per status, so counting
 * generated rows by walking it would state a figure that silently stops at the
 * cap while claiming to describe every withheld row — and would do so only on a
 * catalog large enough for the cap to bite, which is precisely the catalog
 * nobody can check by hand. `withheldByIdentitySourceAndStatus` is accumulated
 * over every row the run scans, BEFORE the cap is applied, so the count here is
 * the whole population by construction.
 *
 * `retired` is a withholding status like the other three: a previously published
 * food a later release no longer carries. It is counted here when the scope
 * scanned it, because a retired generated row is still in the database and still
 * absent from the release, which is the distinction this block is drawing.
 */
export const generatedContentPresence = (
    publishedByIdentitySource: Readonly<Record<string, number>>,
    withheldByIdentitySourceAndStatus: Readonly<Record<string, Readonly<Record<string, number>>>>,
): GeneratedContentPresence => {
    const published = ownCount(publishedByIdentitySource, AI_GENERATED_IDENTITY_SOURCE);
    const withheldByStatus = emptyCounts();
    for (const [status, count] of Object.entries(
        ownValue(withheldByIdentitySourceAndStatus, AI_GENERATED_IDENTITY_SOURCE) ?? {},
    )) {
        if (count > 0) {
            withheldByStatus[status] = count;
        }
    }
    const withheldTotal = Object.values(withheldByStatus).reduce((sum, count) => sum + count, 0);
    // formatCount throughout, as everywhere else in this file: a five-figure
    // count without separators reads as a different order of magnitude.
    const describe = Object.keys(withheldByStatus)
        .sort(compareStrings)
        .map((status) => `${status} ${formatCount(ownCount(withheldByStatus, status))}`);

    return {
        publishedGeneratedFoods: published,
        withheldGeneratedRowsByStatus: sortedRecord(withheldByStatus),
        withheldGeneratedRowsTotal: withheldTotal,
        measuredFrom:
            'catalog_foods.identity_source, counted over published rows and over every withheld row this run ' +
            'scanned — accumulated as the rows are read, before the per-status cap on the listed identities, so ' +
            'neither figure stops at that cap. Not read from a generation counter, so it states what is in the ' +
            'catalog rather than what a run attempted.',
        labellingConsequence:
            published === 0
                ? 'No generated identity is published, so no search row, recipe or diary entry in this release ' +
                  'carries AI-estimated nutrition and the estimate labelling the Agent Action Plan requires has ' +
                  'nothing to label. Recipe planning is unaffected either way: it admits source_backed ' +
                  'ingredients only.'
                : `${formatCount(published)} generated identity(ies) are published, so every one of them must carry an ` +
                  'estimate label in search, in detail and in the diary, and none of them is eligible as a recipe ' +
                  'ingredient.',
        statement:
            `${formatCount(published)} generated identity(ies) published; ${formatCount(withheldTotal)} ` +
            `generated row(s) withheld` +
            (describe.length === 0 ? '' : ` (${describe.join(', ')})`) +
            '. A withheld row is in the database and counted here, but it is absent from the release, from search ' +
            'and from recipe eligibility.',
    };
};

/**
 * The quarantine block's view of a withheld identity: the same facts without
 * the status, which every entry in that block carries by construction.
 *
 * Written out field by field rather than by deleting a key, so the emitted
 * shape is declared in one place and a new field on the audit cannot silently
 * appear in the quarantine block.
 */
export const toQuarantinedIdentity = (identity: WithheldIdentity): QuarantinedIdentity => ({
    sourceKey: identity.sourceKey,
    category: identity.category,
    foodState: identity.foodState,
    displayName: identity.displayName,
    identitySource: identity.identitySource,
    outcome: identity.outcome,
    failingChecks: identity.failingChecks,
    failingCheckEvidence: identity.failingCheckEvidence,
});

export interface IdentityCollision {
    readonly canonicalName: string;
    readonly foodState: string;
    readonly sourceKeys: readonly string[];
}

export interface RecordFieldMismatch {
    readonly sourceKey: string;
    readonly field: string;
    readonly foodValue: string;
    readonly recordValue: string;
}

/**
 * The columns a validation record mirrors from its food, and how to read each
 * from both sides. Declared as data so the comparison cannot drift from the
 * list of fields it claims to cover.
 */
const MIRRORED_FIELDS: readonly {
    readonly field: string;
    readonly ofFood: (row: ReportFoodRow) => string;
    readonly ofRecord: (record: ValidationRecordRow) => string;
}[] = [
    { field: 'category', ofFood: (row) => row.category, ofRecord: (record) => record.category },
    { field: 'foodState', ofFood: (row) => row.food_state, ofRecord: (record) => record.food_state },
    { field: 'identitySource', ofFood: (row) => row.identity_source, ofRecord: (record) => record.identity_source },
    { field: 'identityStatus', ofFood: (row) => row.identity_status, ofRecord: (record) => record.identity_status },
    {
        field: 'nutritionProvenance',
        ofFood: (row) => row.nutrition_provenance,
        ofRecord: (record) => record.nutrition_provenance,
    },
    {
        field: 'publicationStatus',
        ofFood: (row) => row.publication_status,
        ofRecord: (record) => record.publication_status,
    },
];

/** Enough mismatches to diagnose a pattern without turning the artefact into a
 * dump; the count beside the list is the complete figure. */
const MISMATCH_EXAMPLE_LIMIT = 20;

/** Enough named items to act on an unexplained check gap — which is a pattern
 * across a release rather than a per-item accident — without dumping the
 * catalog. The per-name counts beside the list are exact, and the number of
 * items the cap left unnamed is emitted with them. */
const UNEXPLAINED_GAP_EXAMPLE_LIMIT = 20;

/* ---------------------------------------------------------------------------
 * THE CLOSED VALUE SETS THE COUNTERS ARE KEYED BY
 *
 * WHY A COUNTER KEY IS VALIDATED AND NOT MERELY COUNTED. Every column the
 * aggregate pass keys a counter on is TEXT with no database enum behind it (the
 * schema is introspected — Rule backend-architecture §10), so the only thing
 * standing between the report and an arbitrary key is the stage that wrote the
 * row. A value outside the set its column declares is therefore either a defect
 * in one of those stages or a row somebody edited by hand, and counting it
 * under whatever string arrived produces an artefact whose `published`,
 * `quarantined` and `withheld` figures each omit that row while stating nothing
 * about it — the "claim nothing checked" this file's header exists to refuse.
 *
 * WHY THE SETS ARE IMPORTED AND NEVER RESTATED. `src/services/catalog.logic.ts`
 * is the one enforcement point for these vocabularies; a list copied here would
 * be a second authority that can drift from the one the pipeline wrote the rows
 * under, and the first symptom would be a report refusing a value the rest of
 * the system accepts. `catalog_validation_records.outcome` is the single
 * exception and is derived from its own union below, for the reason recorded
 * there.
 *
 * WHAT IS DELIBERATELY *NOT* IN THIS TABLE:
 *
 *   * `category` — validated against `coverage-plan.v1.json` by
 *     `computeCoverageShortfall`, which excludes an undeclared category from
 *     every total and names it in `coverage.unknownCategories`. That is the
 *     explicit bucket for this column and it already reaches both artefacts; a
 *     refusal here would replace a reported, per-release fact with a failed run.
 *   * a recorded CHECK NAME — validated by `KNOWN_CHECK_NAMES`, filed under
 *     tier `unrecognised` and named in `checkVocabulary.unrecognisedCheckNames`
 *     with its count. Same reasoning: an already-explicit bucket.
 *   * `nutrition_method`, `usda_data_type`, `food_group` — free text by
 *     design (a method the validator names, a vendor's dataset label, an
 *     importer's grouping). This repository owns no set for them, so there is
 *     nothing to validate against and inventing one would be exactly the
 *     second authority the paragraph above refuses. Their counters are
 *     prototype-free like every other, which is what makes an arbitrary value
 *     in them harmless rather than dangerous.
 * ------------------------------------------------------------------------- */

/**
 * `catalog_validation_records.outcome`'s three values.
 *
 * Declared here rather than imported because `catalog.logic.ts` exports a guard
 * for every other set in the table below but none for this one. It is derived
 * from the union that owns it — `Record<CatalogValidationOutcome, true>` — so
 * adding a member in `src/types/catalog.ts` without listing it here is a
 * compile error rather than a value this report would quietly refuse. A guard
 * beside the others would be the better home; that file belongs to another
 * change.
 *
 * `hasOwnProperty` and not `in`, for the reason `closedSet` gives in
 * `catalog.logic.ts`: `'toString' in members` is true of every object literal.
 */
const VALIDATION_OUTCOMES: Readonly<Record<CatalogValidationOutcome, true>> = {
    accepted: true,
    quarantined: true,
    rejected: true,
};

const isCatalogValidationOutcome = (value: unknown): boolean =>
    typeof value === 'string' && Object.prototype.hasOwnProperty.call(VALIDATION_OUTCOMES, value);

/**
 * One row's value in a closed-set column, and the set that does not declare it.
 *
 * `value` is already quoted and bounded by {@link quoteStoredValue}: it is
 * stored text, and it reaches a failure message and an operator console.
 */
export interface UnrecognisedStoredValue {
    readonly sourceKey: string;
    readonly field: string;
    readonly value: string;
}

/** Enough named rows to see whether an unrecognised value is one row or a
 * pattern across a stage's whole output; the count beside the list is exact. */
const UNRECOGNISED_VALUE_EXAMPLE_LIMIT = 20;

/** Long enough to recognise the offending value, short enough that a TEXT
 * column cannot turn one row into a megabyte of failure message. */
const STORED_VALUE_QUOTE_LIMIT = 80;

/**
 * A stored value as a failure may quote it.
 *
 * JSON-escaped, because the value is unvalidated text from a TEXT column: a
 * quote or a newline in it would otherwise break the sentence it is embedded
 * in, and a control character would reach an operator's terminal as an escape
 * sequence. Length-bounded for the same reason the identity list is capped —
 * the size of the evidence must not be chosen by the data.
 */
export const quoteStoredValue = (value: unknown): string => {
    const text = typeof value === 'string' ? value : value === null ? 'null' : `<${typeof value}>`;
    const bounded =
        text.length > STORED_VALUE_QUOTE_LIMIT
            ? `${text.slice(0, STORED_VALUE_QUOTE_LIMIT)}\u2026 (${formatCount(text.length)} characters)`
            : text;
    return JSON.stringify(bounded);
};

/**
 * The closed sets, and how to read each from a row.
 *
 * Held as data for the same reason `MIRRORED_FIELDS` and
 * `CHECK_APPLICABILITY_RULES` are: the list of columns checked cannot drift
 * from the list the failure claims to cover.
 *
 * `of` returns `undefined` only where the row states nothing to judge — it
 * carries no validation record at all, which the report already measures and
 * refuses on its own terms (`assertEveryPublishedItemHasARecord`). A column
 * holding SQL `NULL` is a different thing and is judged like any other value:
 * these columns are NOT NULL, so a `null` reaching here is itself the defect.
 */
const CLOSED_SET_COLUMNS: readonly {
    readonly field: string;
    readonly of: (row: ReportFoodRow) => unknown;
    readonly admits: (value: unknown) => boolean;
}[] = [
    { field: 'publication_status', of: (row) => row.publication_status, admits: isCatalogPublicationStatus },
    { field: 'identity_source', of: (row) => row.identity_source, admits: isCatalogIdentitySource },
    { field: 'identity_status', of: (row) => row.identity_status, admits: isCatalogIdentityStatus },
    { field: 'nutrition_provenance', of: (row) => row.nutrition_provenance, admits: isCatalogNutritionProvenance },
    { field: 'nutrition_basis', of: (row) => row.nutrition_basis, admits: isCatalogNutritionBasis },
    { field: 'food_state', of: (row) => row.food_state, admits: isCatalogFoodState },
    {
        field: 'catalog_validation_records.outcome',
        of: (row) => (row.catalog_validation_records === null ? undefined : row.catalog_validation_records.outcome),
        admits: isCatalogValidationOutcome,
    },
];

/**
 * Every closed-set column of one row whose stored value its set does not
 * declare.
 *
 * Pure, so the vocabulary judgement is unit-testable without a database — and
 * so the aggregate pass, which calls it once per row, holds no rule of its own
 * (Rule backend-architecture §7).
 */
export const unrecognisedStoredValuesOfRow = (row: ReportFoodRow): readonly UnrecognisedStoredValue[] => {
    const found: UnrecognisedStoredValue[] = [];
    for (const column of CLOSED_SET_COLUMNS) {
        const value = column.of(row);
        if (value === undefined || column.admits(value)) {
            continue;
        }
        found.push({ sourceKey: row.source_key, field: column.field, value: quoteStoredValue(value) });
    }
    return found;
};

export interface CategoryMeasurement {
    byPublicationStatus: Record<string, number>;
    publishedFoodStates: Record<string, number>;
    publishedReviewFailuresByCheck: Record<string, number>;
    publishedItemsWithRejectFailure: number;
    publishedItemsWithQuarantineFailure: number;
    publishedItemsWithReviewFailure: number;
    quarantinedByCheck: Record<string, number>;
}

export interface CatalogMeasurement {
    readonly rowsScanned: number;
    readonly byPublicationStatus: Record<string, number>;
    readonly categories: Record<string, CategoryMeasurement>;
    readonly publishedByCategory: Record<string, number>;
    readonly publishedByIdentitySource: Record<string, number>;
    readonly publishedByIdentityStatus: Record<string, number>;
    readonly publishedByNutritionProvenance: Record<string, number>;
    readonly publishedByNutritionMethod: Record<string, number>;
    readonly publishedByNutritionBasis: Record<string, number>;
    readonly publishedByUsdaDataType: Record<string, number>;
    readonly publishedByOutcome: Record<string, number>;
    readonly publishedByFoodState: Record<string, number>;
    readonly publishedChecks: Record<string, CheckTally>;
    readonly publishedCheckEntries: number;
    readonly publishedItemsWithNoFailingCheck: number;
    readonly publishedItemsWithBothReviewFlags: number;
    readonly unrecognisedCheckNames: Record<string, number>;
    /** Vocabulary check names per published item, as a distribution: how many
     * items recorded how many names. Replaces the single scalar an aggregate
     * can only state when every item happens to agree. */
    readonly publishedRecordedChecksPerItem: Record<string, number>;
    /** Not-applicable entries over the published items, counted by check name. */
    readonly publishedNotApplicableByName: Record<string, number>;
    /** The same entries counted by the stable reason code that explained them. */
    readonly publishedNotApplicableByReasonCode: Record<string, number>;
    /** Items whose recorded ∪ not-applicable names cover the whole vocabulary. */
    readonly publishedItemsWithCompleteVocabulary: number;
    /** Items carrying at least one absence no applicability rule explains. */
    readonly publishedItemsWithUnexplainedGap: number;
    /** Those unexplained absences counted by check name. */
    readonly publishedUnexplainedByName: Record<string, number>;
    /** Named examples of them, capped; the counts above are exact. */
    readonly publishedUnexplainedExamples: readonly { readonly sourceKey: string; readonly names: readonly string[] }[];
    readonly publishedUnexplainedExamplesOmitted: number;
    readonly quarantinedByCheck: Record<string, number>;
    readonly quarantinedByCategory: Record<string, number>;
    readonly rejectedByCheck: Record<string, number>;
    readonly candidateByCheck: Record<string, number>;
    readonly quarantinedIdentities: readonly QuarantinedIdentity[];
    /**
     * Every candidate, quarantined and rejected row's identity, in one sorted
     * collection — the audit that answers "what did the catalog withhold, and
     * why" from the committed evidence alone.
     */
    readonly withheldIdentities: readonly WithheldIdentity[];
    /**
     * Identities the {@link WITHHELD_IDENTITY_LIMIT} cap left out, per status.
     * Emitted beside every list this collection feeds, so a capped list is
     * never mistaken for a complete one.
     */
    readonly withheldIdentitiesOmitted: Record<string, number>;
    /**
     * Every withheld row this run scanned, counted by `identity_source` and
     * then by `publication_status` — accumulated BEFORE the cap above, so it is
     * the whole withheld population however large it is. The identity list is
     * evidence a reader inspects; this is the population a figure is derived
     * from, and the two must not be confused (see generatedContentPresence).
     */
    readonly withheldByIdentitySourceAndStatus: Record<string, Record<string, number>>;
    readonly publishedWithoutValidationRecord: readonly string[];
    readonly publishedAliasRecords: number;
    readonly publishedEvidenceRecords: number;
    readonly publishedEvidenceRecordsPerItem: Record<string, number>;
    readonly publishedItemsWithoutEvidence: number;
    readonly publishedItemsWithAdvisoryReview: number;
    readonly publishedIdentityCollisions: readonly IdentityCollision[];
    readonly recordFieldMismatchCount: number;
    readonly recordFieldMismatches: readonly RecordFieldMismatch[];
    readonly rowsWithValidationRecord: number;
    /**
     * Stored values in a column whose value set this repository owns that the
     * set does not declare — named rows and columns, capped at
     * {@link UNRECOGNISED_VALUE_EXAMPLE_LIMIT}.
     *
     * Collected rather than thrown on at the row, so one failure can state the
     * whole pattern instead of the first row of it (the same shape as
     * `publishedWithoutValidationRecord` and `recordFieldMismatches`).
     * `assertRecognisedStoredValues` is what refuses the run.
     */
    readonly unrecognisedStoredValues: readonly UnrecognisedStoredValue[];
    /** Every such value the scan found, uncapped. */
    readonly unrecognisedStoredValueCount: number;
}

/**
 * One failed check as a withheld row's evidence states it: the name, the tier
 * that decided the row's disposition, and the DATA behind the verdict.
 *
 * WHY THE NAME ALONE IS NOT ENOUGH. A withheld identity that says only
 * `out_of_category_range` tells an operator which rule the row broke and
 * nothing about how badly, or against what — so the row cannot be triaged, a
 * bound cannot be re-examined, and the withholding cannot be checked without
 * re-running the validator. `observed` and `bound` are already on every stored
 * check (src/types/catalog.ts::CatalogValidationCheck) and they are exactly the
 * non-sensitive judgement data: a kcal figure against a category range, a
 * gram mass against a basis, a name against a pattern. Nothing in a check is
 * user data — these tables have no `user_id` column at all — so carrying them
 * into the evidence artefacts discloses nothing.
 *
 * `pass` is `false` on every entry, by construction: this projection is built
 * only from checks the record states as failed. It is emitted anyway so a
 * reader of one entry does not have to know that to read it.
 */
export interface WithheldCheckEvidence {
    readonly name: string;
    /** `'unrecognised'` where the stored name is outside the vocabulary. */
    readonly tier: string;
    readonly pass: false;
    readonly observed: number | string | null;
    readonly bound: number | string | null;
}

interface FailingCheckSummary {
    readonly names: readonly string[];
    /**
     * The same failures as {@link names}, with the observed value and bound
     * each one recorded. Same order, so the two are read as one list.
     */
    readonly failing: readonly WithheldCheckEvidence[];
    readonly entries: number;
    readonly passed: number;
    readonly byTier: Readonly<Record<string, number>>;
}

/**
 * A stored `observed` or `bound` as the artefact may carry it.
 *
 * The column is JSON, so the value can be anything the writer put there. A
 * number or a string passes through; `null` is the honest value for a presence
 * check that has neither; anything else — an object, an array, a boolean —
 * becomes its JSON text rather than being dropped, because a value the reader
 * cannot interpret is still better evidence than a silently missing one.
 */
const asCheckValue = (value: unknown): number | string | null => {
    if (value === null || value === undefined) {
        return null;
    }
    if (typeof value === 'number' || typeof value === 'string') {
        return value;
    }
    return JSON.stringify(value);
};

const KNOWN_CHECK_NAMES: ReadonlySet<string> = new Set<string>([
    ...CATALOG_REJECT_CHECK_NAMES,
    ...CATALOG_QUARANTINE_CHECK_NAMES,
    ...CATALOG_REVIEW_CHECK_NAMES,
]);

/**
 * The tier of a recorded check name, or `null` when the name is not one the
 * vocabulary declares.
 *
 * A stored name outside the vocabulary is a real possibility — the column is
 * TEXT and the schema declares no enums — and it is reported under
 * `unrecognisedCheckNames` rather than filed under a guessed tier, because a
 * tier decides a row's disposition and inventing one would misreport it.
 */
const tierOfCheck = (name: string): string | null =>
    KNOWN_CHECK_NAMES.has(name) ? catalogCheckTier(name as CatalogCheckName) : null;

const summarizeChecks = (checks: unknown, unrecognised: Record<string, number>): FailingCheckSummary => {
    const names: string[] = [];
    const failing: WithheldCheckEvidence[] = [];
    // Keyed by the closed tier set rather than by data, but created the same
    // way as every other map here: one plain `{}` left among them is the one a
    // later edit feeds a stored check name to.
    const byTier = emptyCounts();
    let entries = 0;
    let passed = 0;

    for (const entry of asArray(checks)) {
        const record = asRecord(entry);
        if (record === null || typeof record.name !== 'string') {
            continue;
        }
        entries += 1;
        const name = record.name;
        const tier = tierOfCheck(name);
        if (tier === null) {
            increment(unrecognised, name);
        }
        if (record.pass === true) {
            passed += 1;
            continue;
        }
        names.push(name);
        // The judgement data beside the name, read from the record rather than
        // re-derived: `observed` and `bound` are what the validator compared,
        // and a report that re-computed them could disagree with the record it
        // is describing.
        failing.push({
            name,
            tier: tier ?? 'unrecognised',
            pass: false,
            observed: asCheckValue(record.observed),
            bound: asCheckValue(record.bound),
        });
        if (tier !== null) {
            increment(byTier, tier);
        }
    }

    return { names, failing, entries, passed, byTier };
};

// ---------------------------------------------------------------------------
// Per-item check completeness.
//
// THE PROBLEM THIS SOLVES. The vocabulary has 23 names and a published item's
// record carries only the checks the validator EVALUATED on it — a name whose
// precondition the item does not meet is absent, not failed. Read without that
// distinction, a record carrying a subset of the 23 looks like evidence with
// holes in it, and a report that simply asserted "every item carries every
// check" would be making a claim its own item records contradict.
//
// The distinction cuts both ways, and the second direction is the one that
// bites: a check the validator DID evaluate must never be filed here as
// inapplicable. See the four names deliberately absent from
// CHECK_APPLICABILITY_RULES below.
//
// So the completeness claim is COMPUTED here instead: for every vocabulary name
// absent from an item's record, either this item's own measured facts explain
// why the check could not apply — and the explanation is emitted as evidence
// beside the checks — or the absence is an UNEXPLAINED GAP and is named as one.
// Nothing in here invents a pass, an observed value or a bound for a check the
// validator did not evaluate: a not-applicable entry carries `applicable:
// false` and a reason, and no verdict at all.
// ---------------------------------------------------------------------------

/**
 * The volume basis, the one `nutrition_basis` value whose conversion consults a
 * density (`missing_density`'s applicability rule below).
 */
const PER_100ML = 'per_100ml';

const AI_GENERATED = 'ai_generated';
const INGREDIENT_DERIVED = 'ingredient_derived';

/**
 * The keys a portion entry would carry if it stated per-serving nutrient values
 * of its own — the second nutrient statement `portion_conversion_drift` needs
 * in order to have anything to compare the per-100 g values against.
 *
 * Matched case- and separator-insensitively because the record's `portion_units`
 * is whatever JSON the writing stage stored: the validator writes the storage
 * casing, and an importer that carried a source's own per-serving block could
 * write either.
 */
const PORTION_NUTRIENT_KEYS: ReadonlySet<string> = new Set<string>([
    'calories',
    'kcal',
    'energy',
    'protein',
    'proteing',
    'carbs',
    'carbsg',
    'carbohydrate',
    'fat',
    'fatg',
    'fiber',
    'fiberg',
]);

const normalizeKey = (key: string): string => key.toLowerCase().replace(/[^a-z0-9]/g, '');

const statesPerServingNutrients = (entry: unknown): boolean => {
    const record = asRecord(entry);
    return record !== null && Object.keys(record).some((key) => PORTION_NUTRIENT_KEYS.has(normalizeKey(key)));
};

/**
 * The measured facts about ONE published item that decide which checks could
 * have applied to it.
 *
 * Every field is read off the item's own row or its own validation record —
 * there is no catalog-wide value in here — because a reason derived from an
 * aggregate ("no food in this release is ai_generated") would not be evidence
 * about this item.
 */
export interface PublishedItemFacts {
    readonly sourceKey: string;
    readonly category: string;
    readonly foodState: string;
    readonly identitySource: string;
    readonly nutritionProvenance: string;
    readonly nutritionBasis: string;
    readonly basisAmount: number;
    /** Rows in `catalog_food_components` for this food. */
    readonly componentRows: number;
    /** Entries in the validation record's `portion_units`. */
    readonly portionUnits: number;
    /** Those entries that state per-serving nutrient values of their own. */
    readonly portionUnitsStatingNutrients: number;
    /** The check names the validator recorded on this item, as recorded. */
    readonly recordedCheckNames: readonly string[];
}

/** One vocabulary name this item's facts show the validator could not evaluate. */
export interface CheckNotApplicable {
    readonly name: string;
    readonly tier: string;
    readonly applicable: false;
    /** A stable code for aggregation; the prose beside it is item-specific. */
    readonly reasonCode: string;
    readonly reason: string;
}

export interface ItemCheckCompleteness {
    /** Vocabulary names recorded on this item, sorted. */
    readonly recorded: readonly string[];
    /** Recorded names the vocabulary does not declare, sorted. */
    readonly recordedOutsideVocabulary: readonly string[];
    readonly notApplicable: readonly CheckNotApplicable[];
    /** Absent names no applicability rule covers — the honest "we cannot explain this". */
    readonly unexplained: readonly string[];
    /** True only when recorded ∪ notApplicable covers the whole vocabulary. */
    readonly complete: boolean;
}

/**
 * One applicability rule: when the check COULD have been recorded, and the
 * reason it could not be, written from the item's own facts.
 *
 * Held as data rather than as a chain of `if`s so the rule set can be read as a
 * list, and so a name with no rule is visibly uncovered instead of falling
 * through a final `else` into an invented explanation.
 */
interface CheckApplicabilityRule {
    readonly applies: (facts: PublishedItemFacts) => boolean;
    readonly reasonCode: string;
    readonly reason: (facts: PublishedItemFacts) => string;
}

/**
 * Why each rule is the rule, traced to the recording site in
 * `src/services/catalog.logic.ts` — the module that owns the checks:
 *
 *  * `brand_pattern_name` is pushed only for an `ai_generated` candidate
 *    (`validateCatalogCandidate`), because a USDA Branded record's brand was
 *    asserted by the vendor rather than proposed by a model.
 *  * `empty_component_set` and `invalid_component_quantity` are produced only
 *    inside `deriveComponentNutrition`, which runs for an ingredient-derived
 *    food's component set.
 *  * `missing_density` is reachable only from the `per_100ml` branch of
 *    `normalizeToPer100g`: millilitres become grams through the stored density,
 *    and nothing else consults one.
 *  * `portion_conversion_drift` returns `null` when the candidate states no
 *    per-serving nutrition, or when no field could be compared
 *    (`portionDriftCheck`). A stored row carries one nutrient statement on one
 *    basis, so unless the record's portion entries carry per-serving values
 *    there is nothing to compare.
 *  * `default_portion_count` and `unsupported_portion` are both inside
 *    `presenceChecks`' `portions.length > 0` guard, so a record stating no
 *    portion at all is the only thing that can leave them out. They are
 *    deliberately APPLICABLE to an item that does state portions: an item with
 *    portions and no `default_portion_count` entry is a record written before
 *    that check existed, and that is exactly what this helper must report as a
 *    gap rather than explain away.
 *
 * FOUR NAMES DELIBERATELY HAVE NO RULE HERE, and their absence from this map is
 * the point. `invalid_basis_amount` and `non_finite_computed_value` are
 * EVALUATED by `normalizeToPer100g` on every candidate it converts — the basis
 * test unconditionally, the finiteness guards on the basis mass, the rescale
 * factor and every rescaled nutrient — and a published item is by definition
 * one whose conversion succeeded. There is therefore no fact about a published
 * item that could make either check inapplicable to it, and an earlier version
 * of this map that claimed otherwise filed `applicable: false` against two
 * checks that had in fact run and passed on all of them.
 *
 * They are now recorded as passes at the point the record is written
 * (`scripts/catalog-validate.ts::recordedChecks`), so a current record carries
 * both. A record that does NOT carry them is one written before that fix, and
 * the honest report of it is an UNEXPLAINED gap — a record to re-validate —
 * which is exactly what a name with no rule produces here.
 *
 * `unknown_tag_code` and `inconsistent_tag_set` are the other two, for the same
 * reason arrived at from the other end. `tagVocabularyChecks` omits them when
 * their inputs are unavailable — the first needs at least one of the two tag
 * lists, the second needs both, because it is a statement about their agreement
 * — so on a bare candidate either can legitimately be absent. But the stage
 * that judges a stored row for publication is not a bare candidate:
 * `scripts/catalog-validate.ts::candidateFromRow` supplies BOTH lists from the
 * row (its `selection` names `allergen_tags` and `diet_tags`, and both columns
 * are NOT NULL with a `[]` default — an omitted list is stored as the empty set
 * it means, and an empty supplied list is an ANSWER the checks judge). Every
 * record that stage writes therefore evaluates both, and no fact about a
 * PUBLISHED item can make either inapplicable to it. A rule keyed on the stored
 * lists being empty would be precisely the unfounded claim the paragraph above
 * describes, since `[]` cannot be told apart from a list nobody supplied. A
 * record lacking them predates the checks, and is reported as the gap it is.
 */
const CHECK_APPLICABILITY_RULES: Readonly<Record<string, CheckApplicabilityRule>> = {
    [CATALOG_CHECK_NAMES.BRAND_PATTERN_NAME]: {
        applies: (facts) => facts.identitySource === AI_GENERATED,
        reasonCode: 'identity_source_is_not_ai_generated',
        reason: (facts) =>
            `the generated-name screen runs only on an ${AI_GENERATED} candidate; this item's identity_source is ` +
            `"${facts.identitySource}"`,
    },
    [CATALOG_CHECK_NAMES.EMPTY_COMPONENT_SET]: {
        applies: (facts) => facts.componentRows > 0 || facts.nutritionProvenance === INGREDIENT_DERIVED,
        reasonCode: 'no_component_set_was_derived',
        reason: (facts) =>
            `component nutrition is derived only for an ${INGREDIENT_DERIVED} food; this item declares ` +
            `${formatCount(facts.componentRows)} component row(s) and its nutrition_provenance is ` +
            `"${facts.nutritionProvenance}"`,
    },
    [CATALOG_CHECK_NAMES.INVALID_COMPONENT_QUANTITY]: {
        applies: (facts) => facts.componentRows > 0 || facts.nutritionProvenance === INGREDIENT_DERIVED,
        reasonCode: 'no_component_set_was_derived',
        reason: (facts) =>
            `a component quantity can only be judged where a component exists; this item declares ` +
            `${formatCount(facts.componentRows)} component row(s) and its nutrition_provenance is ` +
            `"${facts.nutritionProvenance}"`,
    },
    [CATALOG_CHECK_NAMES.MISSING_DENSITY]: {
        applies: (facts) => facts.nutritionBasis === PER_100ML,
        reasonCode: 'no_volume_basis_to_convert',
        reason: (facts) =>
            `a density is consulted only to convert a volume basis to grams; this item states its nutrition ` +
            `${facts.nutritionBasis}`,
    },
    [CATALOG_CHECK_NAMES.PORTION_CONVERSION_DRIFT]: {
        applies: (facts) => facts.portionUnitsStatingNutrients > 0,
        reasonCode: 'no_per_serving_values_to_compare',
        reason: (facts) =>
            `the per-100 g values had nothing to be compared against: the record's ` +
            `${formatCount(facts.portionUnits)} portion unit(s) state amounts and gram weights and none carries ` +
            'source-stated per-serving nutrient values',
    },
    [CATALOG_CHECK_NAMES.DEFAULT_PORTION_COUNT]: {
        applies: (facts) => facts.portionUnits > 0,
        reasonCode: 'no_portions_stated',
        reason: () => 'the default-portion count is taken over the record\u2019s stated portions, and it states none',
    },
    [CATALOG_CHECK_NAMES.UNSUPPORTED_PORTION]: {
        applies: (facts) => facts.portionUnits > 0,
        reasonCode: 'no_portions_stated',
        reason: () => 'portion amounts, units and weights are judged over the record\u2019s stated portions, and it states none',
    },
};

/**
 * The vocabulary names this item's own facts explain the absence of, the ones
 * they do not, and the completeness that follows.
 *
 * Pure: it reads the facts it is handed and nothing else, so the same item
 * yields the same evidence in the aggregate pass and in the per-item pass.
 */
export const notApplicableChecksForItem = (facts: PublishedItemFacts): ItemCheckCompleteness => {
    const recordedNames = new Set(facts.recordedCheckNames);
    const recorded: string[] = [];
    const recordedOutsideVocabulary: string[] = [];
    for (const name of recordedNames) {
        if (KNOWN_CHECK_NAMES.has(name)) {
            recorded.push(name);
        } else {
            recordedOutsideVocabulary.push(name);
        }
    }

    const notApplicable: CheckNotApplicable[] = [];
    const unexplained: string[] = [];

    for (const name of [...KNOWN_CHECK_NAMES].sort(compareStrings)) {
        if (recordedNames.has(name)) {
            continue;
        }

        // An own-property lookup, though the name comes from the code-owned
        // vocabulary: this map is a plain object literal indexed by a string
        // variable, and `CHECK_APPLICABILITY_RULES['constructor']` would answer
        // with the `Object` function — a "rule" whose `applies` does not exist
        // — the moment a vocabulary name or a caller changed.
        const rule = ownValue(CHECK_APPLICABILITY_RULES, name);
        if (rule === undefined || rule.applies(facts)) {
            // Either no rule covers this name, or the item DOES meet the
            // precondition and the check is still absent. Both are reported as
            // gaps: a report that guessed at a reason here would be the same
            // unfounded claim this block exists to remove.
            unexplained.push(name);
            continue;
        }

        notApplicable.push({
            name,
            tier: tierOfCheck(name) ?? 'unrecognised',
            applicable: false,
            reasonCode: rule.reasonCode,
            reason: rule.reason(facts),
        });
    }

    return {
        recorded: recorded.sort(compareStrings),
        recordedOutsideVocabulary: recordedOutsideVocabulary.sort(compareStrings),
        notApplicable,
        unexplained,
        complete: unexplained.length === 0,
    };
};

/**
 * One published item's facts, read from its row and its validation record.
 *
 * Shared by both passes so the per-item evidence and the aggregate counts are
 * derived from identical inputs — two extractions would be two chances to
 * disagree about the same item.
 */
export const publishedItemFacts = (row: ReportFoodRow, record: ValidationRecordRow): PublishedItemFacts => {
    const portions = asArray(record.portion_units);

    return {
        sourceKey: row.source_key,
        category: row.category,
        foodState: row.food_state,
        identitySource: row.identity_source,
        nutritionProvenance: row.nutrition_provenance,
        nutritionBasis: row.nutrition_basis,
        basisAmount: row.basis_amount,
        componentRows: row._count.catalog_food_components,
        portionUnits: portions.length,
        portionUnitsStatingNutrients: portions.filter((entry) => statesPerServingNutrients(entry)).length,
        recordedCheckNames: asArray(record.checks)
            .map((entry) => {
                const check = asRecord(entry);
                return check !== null && typeof check.name === 'string' ? check.name : '';
            })
            .filter((name) => name.length > 0),
    };
};

const emptyCategoryMeasurement = (): CategoryMeasurement => ({
    byPublicationStatus: emptyCounts(),
    publishedFoodStates: emptyCounts(),
    publishedReviewFailuresByCheck: emptyCounts(),
    publishedItemsWithRejectFailure: 0,
    publishedItemsWithQuarantineFailure: 0,
    publishedItemsWithReviewFailure: 0,
    quarantinedByCheck: emptyCounts(),
});

/** The key a published identity is unique on, per the partial unique index on
 * `(canonical_name, food_state) WHERE publication_status = 'published'`. NUL
 * joins the parts because no catalog name contains it, so two different pairs
 * can never collide into one key. */
const identityKey = (canonicalName: string, foodState: string): string => `${canonicalName}\u0000${foodState}`;

/** The key `publishedByUsdaDataType` files a food with no USDA data type under —
 * an AI-generated identity has none, and an absent value is reported as its own
 * bucket rather than dropped. */
const NO_USDA_DATA_TYPE = 'none';

/**
 * Every figure the two artefacts state, measured in one scan so they cannot
 * disagree with each other about the rows they describe.
 */
export const measureCatalog = async (db: ReportDb, where: Record<string, unknown>): Promise<CatalogMeasurement> => {
    // Every map below is keyed by data read out of the catalog, so every one of
    // them is prototype-free (see KEY SAFETY above). They are the artefacts'
    // counter blocks, which is why they are prototype-free OBJECTS and not
    // `Map`s: a `Map` serialises to `{}`.
    const byPublicationStatus = emptyCounts();
    const categories = emptyIndex<CategoryMeasurement>();
    const publishedByCategory = emptyCounts();
    const publishedByIdentitySource = emptyCounts();
    const publishedByIdentityStatus = emptyCounts();
    const publishedByNutritionProvenance = emptyCounts();
    const publishedByNutritionMethod = emptyCounts();
    const publishedByNutritionBasis = emptyCounts();
    const publishedByUsdaDataType = emptyCounts();
    const publishedByOutcome = emptyCounts();
    const publishedByFoodState = emptyCounts();
    const publishedChecks = emptyIndex<CheckTally>();
    const unrecognisedCheckNames = emptyCounts();
    const quarantinedByCheck = emptyCounts();
    const quarantinedByCategory = emptyCounts();
    const rejectedByCheck = emptyCounts();
    const candidateByCheck = emptyCounts();
    const publishedEvidenceRecordsPerItem = emptyCounts();
    const publishedRecordedChecksPerItem = emptyCounts();
    const publishedNotApplicableByName = emptyCounts();
    const publishedNotApplicableByReasonCode = emptyCounts();
    const publishedUnexplainedByName = emptyCounts();
    const publishedUnexplainedExamples: { sourceKey: string; names: readonly string[] }[] = [];
    const withheldIdentities: WithheldIdentity[] = [];
    const withheldIdentitiesOmitted = emptyCounts();
    // A `Map` rather than a prototype-free object, because unlike its
    // neighbours this counter never leaves the scan: nothing serialises it, so
    // the strongest form of key isolation costs nothing here.
    const withheldCollected = new Map<string, number>();
    // Uncapped, and deliberately separate from the collected list: a figure
    // derived from a capped list understates the population it claims to
    // describe, and does so only once the catalog is too big to check by hand.
    const withheldByIdentitySourceAndStatus = emptyIndex<Record<string, number>>();
    const publishedWithoutValidationRecord: string[] = [];
    const publishedIdentities = new Map<string, string[]>();
    const recordFieldMismatches: RecordFieldMismatch[] = [];
    const unrecognisedStoredValues: UnrecognisedStoredValue[] = [];

    let rowsScanned = 0;
    let rowsWithValidationRecord = 0;
    let recordFieldMismatchCount = 0;
    let publishedCheckEntries = 0;
    let publishedItemsWithNoFailingCheck = 0;
    let publishedItemsWithMultipleReviewFailures = 0;
    let publishedAliasRecords = 0;
    let publishedEvidenceRecords = 0;
    let publishedItemsWithoutEvidence = 0;
    let publishedItemsWithAdvisoryReview = 0;
    let publishedItemsWithCompleteVocabulary = 0;
    let publishedItemsWithUnexplainedGap = 0;
    let publishedUnexplainedExamplesOmitted = 0;
    let unrecognisedStoredValueCount = 0;

    const categoryOf = (category: string): CategoryMeasurement => {
        // The own-property read is what makes this a lookup of a MEASUREMENT.
        // On a plain object `categories['__proto__']` answers with
        // `Object.prototype` and `categories['constructor']` with the `Object`
        // function — neither of which is `undefined`, so the cache appeared to
        // hit and the counters below were then incremented on the prototype
        // every object in this process inherits from.
        const existing = ownValue(categories, category);
        if (existing !== undefined) {
            return existing;
        }
        const created = emptyCategoryMeasurement();
        categories[category] = created;
        return created;
    };

    /**
     * Records one withheld row's identity, or counts it as omitted once the cap
     * for its status is reached.
     *
     * The counter is incremented rather than the row dropped, because a list
     * that stopped silently would read as the complete set of withheld
     * identities for a catalog that has more.
     */
    const collectWithheldIdentity = (row: ReportFoodRow, summary: FailingCheckSummary): void => {
        // Counted first and unconditionally: this is the population, and it must
        // not depend on whether the identity below was listed or capped out.
        const bySource =
            ownValue(withheldByIdentitySourceAndStatus, row.identity_source) ??
            (withheldByIdentitySourceAndStatus[row.identity_source] = emptyCounts());
        increment(bySource, row.publication_status);

        // A counter per status rather than a scan of what is already collected:
        // the scan would be quadratic in the withheld row count, on a stage
        // whose whole memory discipline is per-page.
        if ((withheldCollected.get(row.publication_status) ?? 0) >= WITHHELD_IDENTITY_LIMIT) {
            increment(withheldIdentitiesOmitted, row.publication_status);
            return;
        }
        withheldCollected.set(row.publication_status, (withheldCollected.get(row.publication_status) ?? 0) + 1);

        withheldIdentities.push({
            sourceKey: row.source_key,
            category: row.category,
            foodState: row.food_state,
            displayName: row.display_name,
            identitySource: row.identity_source,
            outcome: row.catalog_validation_records === null ? null : row.catalog_validation_records.outcome,
            failingChecks: [...summary.names].sort(compareStrings),
            failingCheckEvidence: [...summary.failing].sort((left, right) =>
                compareStrings(left.name, right.name),
            ),
            publicationStatus: row.publication_status,
        });
    };

    await forEachFoodPage(db, where, (rows) => {
        for (const row of rows) {
            rowsScanned += 1;

            // Judged BEFORE anything is counted from the row, so the failure
            // names the columns the figures below would have been keyed on.
            // Collected rather than thrown on: `assertRecognisedStoredValues`
            // refuses the run once the scan can state the whole pattern.
            for (const unrecognised of unrecognisedStoredValuesOfRow(row)) {
                unrecognisedStoredValueCount += 1;
                if (unrecognisedStoredValues.length < UNRECOGNISED_VALUE_EXAMPLE_LIMIT) {
                    unrecognisedStoredValues.push(unrecognised);
                }
            }

            increment(byPublicationStatus, row.publication_status);

            const category = categoryOf(row.category);
            increment(category.byPublicationStatus, row.publication_status);

            const record = row.catalog_validation_records;

            if (record !== null) {
                rowsWithValidationRecord += 1;
                for (const mirrored of MIRRORED_FIELDS) {
                    const foodValue = mirrored.ofFood(row);
                    const recordValue = mirrored.ofRecord(record);
                    if (foodValue === recordValue) {
                        continue;
                    }
                    recordFieldMismatchCount += 1;
                    if (recordFieldMismatches.length < MISMATCH_EXAMPLE_LIMIT) {
                        recordFieldMismatches.push({
                            sourceKey: row.source_key,
                            field: mirrored.field,
                            foodValue,
                            recordValue,
                        });
                    }
                }
            }

            if (row.publication_status === PUBLISHED) {
                increment(publishedByCategory, row.category);
                increment(publishedByIdentitySource, row.identity_source);
                increment(publishedByIdentityStatus, row.identity_status);
                increment(publishedByNutritionProvenance, row.nutrition_provenance);
                increment(publishedByNutritionBasis, row.nutrition_basis);
                increment(publishedByUsdaDataType, row.usda_data_type ?? NO_USDA_DATA_TYPE);
                increment(publishedByFoodState, row.food_state);
                increment(category.publishedFoodStates, row.food_state);

                const key = identityKey(row.canonical_name, row.food_state);
                const holders = publishedIdentities.get(key);
                if (holders === undefined) {
                    publishedIdentities.set(key, [row.source_key]);
                } else {
                    holders.push(row.source_key);
                }

                // The per-item evidence requirement, checked here rather than
                // assumed: a published food with no validation record is a
                // defect the run reports by name (see `assertEveryPublishedItemHasARecord`).
                if (record === null) {
                    publishedWithoutValidationRecord.push(row.source_key);
                    continue;
                }

                increment(publishedByNutritionMethod, record.nutrition_method);
                increment(publishedByOutcome, record.outcome);
                publishedAliasRecords += record.aliases.length;

                const evidence = asArray(record.identity_evidence);
                publishedEvidenceRecords += evidence.length;
                increment(publishedEvidenceRecordsPerItem, String(evidence.length));
                if (evidence.length === 0) {
                    publishedItemsWithoutEvidence += 1;
                }
                if (record.llm_review !== null && record.llm_review !== undefined) {
                    publishedItemsWithAdvisoryReview += 1;
                }

                for (const entry of asArray(record.checks)) {
                    const check = asRecord(entry);
                    if (check === null || typeof check.name !== 'string') {
                        continue;
                    }
                    const tier = tierOfCheck(check.name);
                    // THE SITE THE PROTOTYPE-POLLUTION FINDING NAMED. A stored
                    // check name of `__proto__` made this lookup answer with
                    // `Object.prototype` instead of `undefined`, so the `??`
                    // did not fire and `tally.evaluated += 1` below wrote
                    // `evaluated`, `passed` and `failed` onto the prototype of
                    // every object in the process — falsifying the evidence
                    // this stage exists to produce. The own-property read on a
                    // prototype-free map is what makes an absent tally absent.
                    const tally = ownValue(publishedChecks, check.name) ?? {
                        tier: tier ?? 'unrecognised',
                        evaluated: 0,
                        passed: 0,
                        failed: 0,
                    };
                    tally.evaluated += 1;
                    if (check.pass === true) {
                        tally.passed += 1;
                    } else {
                        tally.failed += 1;
                    }
                    publishedChecks[check.name] = tally;
                }

                // The completeness evidence for this item, measured here in the
                // aggregate pass and recomputed identically from the same facts
                // when its own record is emitted (see `toItemRecord`).
                const completeness = notApplicableChecksForItem(publishedItemFacts(row, record));
                increment(publishedRecordedChecksPerItem, String(completeness.recorded.length));
                for (const entry of completeness.notApplicable) {
                    increment(publishedNotApplicableByName, entry.name);
                    increment(publishedNotApplicableByReasonCode, entry.reasonCode);
                }
                if (completeness.complete) {
                    publishedItemsWithCompleteVocabulary += 1;
                } else {
                    publishedItemsWithUnexplainedGap += 1;
                    for (const name of completeness.unexplained) {
                        increment(publishedUnexplainedByName, name);
                    }
                    if (publishedUnexplainedExamples.length < UNEXPLAINED_GAP_EXAMPLE_LIMIT) {
                        publishedUnexplainedExamples.push({
                            sourceKey: row.source_key,
                            names: completeness.unexplained,
                        });
                    } else {
                        publishedUnexplainedExamplesOmitted += 1;
                    }
                }

                const summary = summarizeChecks(record.checks, unrecognisedCheckNames);
                publishedCheckEntries += summary.entries;
                if (summary.names.length === 0) {
                    publishedItemsWithNoFailingCheck += 1;
                }
                if ((summary.byTier.reject ?? 0) > 0) {
                    category.publishedItemsWithRejectFailure += 1;
                }
                if ((summary.byTier.quarantine ?? 0) > 0) {
                    category.publishedItemsWithQuarantineFailure += 1;
                }
                const reviewFailures = summary.byTier.review ?? 0;
                if (reviewFailures > 0) {
                    category.publishedItemsWithReviewFailure += 1;
                }
                if (reviewFailures > 1) {
                    publishedItemsWithMultipleReviewFailures += 1;
                }
                for (const name of summary.names) {
                    if (tierOfCheck(name) === 'review') {
                        increment(category.publishedReviewFailuresByCheck, name);
                    }
                }
                continue;
            }

            // THE WITHHELD ROWS — the other half of the evidence.
            //
            // A published count on its own cannot answer "what did the catalog
            // NOT publish, and why", and that question is exactly what an
            // operator reading a shortfall needs answered. So all three
            // withholding statuses are treated identically here: the same
            // failing-check summarisation, the same identity fields and the
            // same sort. Quarantine keeps its own per-category and per-check
            // counters as well, because both artefacts state those figures and
            // `reconcileQuarantineFigures` compares them across the two files.
            if (WITHHELD_STATUSES.includes(row.publication_status)) {
                const summary = summarizeChecks(record === null ? null : record.checks, unrecognisedCheckNames);

                if (row.publication_status === QUARANTINED) {
                    increment(quarantinedByCategory, row.category);
                    for (const name of summary.names) {
                        increment(quarantinedByCheck, name);
                        increment(category.quarantinedByCheck, name);
                    }
                } else if (row.publication_status === REJECTED) {
                    for (const name of summary.names) {
                        increment(rejectedByCheck, name);
                    }
                } else {
                    for (const name of summary.names) {
                        increment(candidateByCheck, name);
                    }
                }

                collectWithheldIdentity(row, summary);
            }
        }
    });

    const publishedIdentityCollisions: IdentityCollision[] = [];
    for (const [key, sourceKeys] of publishedIdentities) {
        if (sourceKeys.length < 2) {
            continue;
        }
        const [canonicalName, foodState] = key.split('\u0000');
        publishedIdentityCollisions.push({
            canonicalName,
            foodState,
            sourceKeys: [...sourceKeys].sort(compareStrings),
        });
    }
    publishedIdentityCollisions.sort(
        (left, right) =>
            compareStrings(left.canonicalName, right.canonicalName) || compareStrings(left.foodState, right.foodState),
    );

    // Sorted once, on the stable source key, so both the audit and the
    // quarantine block emit their identities in the same reproducible order.
    const sortedWithheld = [...withheldIdentities].sort((left, right) =>
        compareStrings(left.sourceKey, right.sourceKey),
    );

    return {
        rowsScanned,
        byPublicationStatus,
        categories,
        publishedByCategory,
        publishedByIdentitySource,
        publishedByIdentityStatus,
        publishedByNutritionProvenance,
        publishedByNutritionMethod,
        publishedByNutritionBasis,
        publishedByUsdaDataType,
        publishedByOutcome,
        publishedByFoodState,
        publishedChecks,
        publishedCheckEntries,
        publishedItemsWithNoFailingCheck,
        publishedItemsWithBothReviewFlags: publishedItemsWithMultipleReviewFailures,
        unrecognisedCheckNames,
        publishedRecordedChecksPerItem,
        publishedNotApplicableByName,
        publishedNotApplicableByReasonCode,
        publishedItemsWithCompleteVocabulary,
        publishedItemsWithUnexplainedGap,
        publishedUnexplainedByName,
        publishedUnexplainedExamples,
        publishedUnexplainedExamplesOmitted,
        quarantinedByCheck,
        quarantinedByCategory,
        rejectedByCheck,
        candidateByCheck,
        // One collection, two views: the quarantine block's list is a FILTER of
        // the audit's rather than a second traversal, so the two cannot state
        // different identities for the same quarantined row.
        quarantinedIdentities: sortedWithheld.filter((entry) => entry.publicationStatus === QUARANTINED).map(toQuarantinedIdentity),
        withheldIdentities: sortedWithheld,
        withheldIdentitiesOmitted,
        withheldByIdentitySourceAndStatus,
        publishedWithoutValidationRecord: [...publishedWithoutValidationRecord].sort(compareStrings),
        publishedAliasRecords,
        publishedEvidenceRecords,
        publishedEvidenceRecordsPerItem,
        publishedItemsWithoutEvidence,
        publishedItemsWithAdvisoryReview,
        publishedIdentityCollisions,
        recordFieldMismatchCount,
        recordFieldMismatches,
        rowsWithValidationRecord,
        unrecognisedStoredValues,
        unrecognisedStoredValueCount,
    };
};

/**
 * The per-item evidence requirement the prompt states plainly: EVERY published
 * catalog item carries a machine-readable validation record.
 *
 * A short report is the dangerous outcome here — it would read as complete
 * evidence for a catalog that has none for some of its rows — so a gap ends the
 * run and names the identities, which are also what an operator needs to fix it
 * (re-run `npm run catalog:validate` for those foods).
 */
export const assertEveryPublishedItemHasARecord = (measurement: CatalogMeasurement): void => {
    const missing = measurement.publishedWithoutValidationRecord;
    if (missing.length === 0) {
        return;
    }

    const NAMED_LIMIT = 20;
    const named = missing.slice(0, NAMED_LIMIT).join(', ');
    const remainder = missing.length > NAMED_LIMIT ? ` and ${formatCount(missing.length - NAMED_LIMIT)} more` : '';

    throw new CatalogReportError(
        `${formatCount(missing.length)} published catalog food(s) carry no catalog_validation_records row, ` +
            `so no report can claim every published item is evidenced: ${named}${remainder}. ` +
            'Re-run npm run catalog:validate so those foods are judged, then re-run this report.',
        'missing_validation_record',
    );
};

/**
 * Every counter key came from a value set this repository owns.
 *
 * WHY THE RUN ENDS HERE RATHER THAN COUNTING IT. The alternative is an artefact
 * in which the row is absent from `published`, from `quarantined` and from the
 * withheld audit, present only as a key nothing validated, and described by no
 * claim — evidence that reads as complete while omitting a row it scanned.
 * This file already refuses to publish for one published food missing its
 * validation record ({@link assertEveryPublishedItemHasARecord}); a column
 * whose value no set declares is the same kind of defect reached from the other
 * end, and the same answer applies: produce nothing, name what is wrong, and
 * leave the previous pair of artefacts exactly as it was.
 *
 * The message names the sets and where they live, because the fix is either in
 * the rows or in the set — and which of the two it is, is a judgement only the
 * operator can make.
 */
export const assertRecognisedStoredValues = (measurement: CatalogMeasurement): void => {
    if (measurement.unrecognisedStoredValueCount === 0) {
        return;
    }

    const named = measurement.unrecognisedStoredValues
        .map((entry) => `${entry.sourceKey} ${entry.field}=${entry.value}`)
        .join(', ');
    const remainder =
        measurement.unrecognisedStoredValueCount > measurement.unrecognisedStoredValues.length
            ? ` and ${formatCount(
                  measurement.unrecognisedStoredValueCount - measurement.unrecognisedStoredValues.length,
              )} more`
            : '';

    throw new CatalogReportError(
        `${formatCount(measurement.unrecognisedStoredValueCount)} catalog row value(s) are outside the closed set ` +
            'their column declares, so every figure keyed on that column would count them under a string nothing ' +
            `validated: ${named}${remainder}. The sets are owned by src/services/catalog.logic.ts ` +
            '(CATALOG_PUBLICATION_STATUSES, CATALOG_IDENTITY_SOURCES, CATALOG_IDENTITY_STATUSES, ' +
            'CATALOG_NUTRITION_PROVENANCES, CATALOG_NUTRITION_BASES, CATALOG_FOOD_STATES) and, for the outcome, by ' +
            'CatalogValidationOutcome in src/types/catalog.ts. Correct the rows, or add the value to the set that ' +
            'owns it so every stage judges it the same way, then re-run this report.',
        'unrecognised_stored_value',
    );
};

// ---------------------------------------------------------------------------
// The artefact bodies.
// ---------------------------------------------------------------------------

/** The per-category row both artefacts carry, plus the per-category evidence
 * only the validation report needs. Assembled once so the two files cannot
 * state different figures for the same category. */
export interface CoverageRow {
    readonly category: string;
    readonly publishedTarget: number;
    readonly candidateVolume: number | null;
    readonly published: number;
    readonly shortfall: number;
    /**
     * Whether this category's own publishedTarget is unmet — `shortfall > 0`,
     * stated as its own field rather than left to be inferred from the number
     * beside it.
     *
     * A per-category target is a requirement in its own right: recipe
     * eligibility draws on specific categories, so a surplus elsewhere buys
     * nothing here. A reader or a release gate must be able to see the verdict
     * for this category without comparing two numbers and without consulting
     * the whole-catalog flag, which can only ever be the conjunction of these.
     */
    readonly unmet: boolean;
    readonly quarantined: number;
    readonly candidate: number;
    readonly rejected: number;
    readonly retired: number;
    /**
     * Rows that exist for this category and COULD reach the published set:
     * `published + candidate + quarantined`.
     *
     * `rejected` is excluded because a reject-tier failure is never publishable,
     * and `retired` because a retired row was published by an earlier release
     * and a later one carrying it again is a load-time decision this stage does
     * not make. Pure arithmetic over the four measured counts beside it — it
     * asserts nothing about whether any particular withholding CAN be resolved,
     * only about how many rows there are to resolve.
     */
    readonly reachableCeiling: number;
    /**
     * The part of {@link shortfall} that no judgement could close:
     * `max(0, publishedTarget - reachableCeiling)`.
     *
     * Zero means the target is reachable from rows already in the database, so
     * the gap is a withholding to be triaged — the withheld identities and
     * their failing checks say which. Non-zero means this many rows were never
     * obtained for the category at all, and no re-validation, bound change or
     * curator pass can produce them: the input has to grow. That distinction is
     * what an operator reading an unmet target needs first, and it cannot be
     * read off the shortfall alone.
     */
    readonly shortfallBeyondEveryRowObtained: number;
    readonly itemsWithRejectTierFailure: number;
    readonly itemsWithQuarantineTierFailure: number;
    readonly itemsWithReviewTierFailure: number;
    readonly reviewFailuresByCheck: Readonly<Record<string, number>>;
    readonly quarantinedByCheck: Readonly<Record<string, number>>;
    readonly foodStates: Readonly<Record<string, number>>;
    readonly kcalReviewRangeMeasuredAgainst: { readonly min: number; readonly max: number };
    readonly kcalReviewRangeByFoodStateMeasuredAgainst: Readonly<
        Record<string, { readonly min: number; readonly max: number; readonly fromFoodStateOverride: boolean }>
    >;
    readonly energyMacroTolerancePercentMeasuredAgainst: number;
}

/**
 * One status's count off a counter block.
 *
 * An own-property read, because the block may be one another stage or a test
 * built: on a plain `{}` a lookup of an inherited name answers with the
 * inherited value, and a count is the one thing in this file that must come
 * from the rows.
 */
const statusCount = (row: Readonly<Record<string, number>>, status: string): number => ownCount(row, status);

export const buildCoverageRows = (
    policy: CatalogValidationPolicy,
    plan: CoveragePlan,
    measurement: CatalogMeasurement,
    shortfall: CatalogCoverageShortfall,
): readonly CoverageRow[] => {
    const rows = shortfall.categories.map((entry): CoverageRow => {
        const planCategory = plan.categories.find((candidate) => candidate.category === entry.category);
        // Own-property, though the category comes from the plan: the plan is a
        // JSON document on disk, so `categories['constructor']` is reachable
        // from a file rather than from the database, and it would hand this row
        // the `Object` function in place of a measurement.
        const category = ownValue(measurement.categories, entry.category) ?? emptyCategoryMeasurement();
        const bounds = resolveCategoryBounds(policy, entry.category, 'raw' as CatalogFoodState);

        // What the observations in this category were actually measured
        // against, resolved per food state the category holds rather than
        // assumed: `grain` and `legume` override the category-wide band for
        // their dry and cooked forms, and `resolveCategoryBounds` is the rule
        // that decides which band applies.
        const byFoodState = emptyIndex<{ min: number; max: number; fromFoodStateOverride: boolean }>();
        for (const foodState of Object.keys(category.publishedFoodStates)) {
            const resolved = resolveCategoryBounds(policy, entry.category, foodState as CatalogFoodState);
            if (resolved === null) {
                continue;
            }
            byFoodState[foodState] = {
                min: resolved.kcalRange.min,
                max: resolved.kcalRange.max,
                fromFoodStateOverride: resolved.kcalRangeFromFoodState,
            };
        }

        const quarantined = statusCount(category.byPublicationStatus, QUARANTINED);
        const candidate = statusCount(category.byPublicationStatus, 'candidate');
        const reachableCeiling = entry.published + candidate + quarantined;

        return {
            category: entry.category,
            publishedTarget: entry.publishedTarget,
            candidateVolume: planCategory === undefined ? null : planCategory.candidateVolume,
            published: entry.published,
            // Exact, as `computeCoverageShortfall` measured it: never rounded,
            // never offset against a surplus in another category.
            shortfall: entry.shortfall,
            unmet: entry.shortfall > 0,
            quarantined,
            candidate,
            rejected: statusCount(category.byPublicationStatus, REJECTED),
            retired: statusCount(category.byPublicationStatus, 'retired'),
            reachableCeiling,
            shortfallBeyondEveryRowObtained: Math.max(0, entry.publishedTarget - reachableCeiling),
            itemsWithRejectTierFailure: category.publishedItemsWithRejectFailure,
            itemsWithQuarantineTierFailure: category.publishedItemsWithQuarantineFailure,
            itemsWithReviewTierFailure: category.publishedItemsWithReviewFailure,
            reviewFailuresByCheck: sortedRecord(category.publishedReviewFailuresByCheck),
            quarantinedByCheck: sortedRecord(category.quarantinedByCheck),
            foodStates: sortedRecord(category.publishedFoodStates),
            kcalReviewRangeMeasuredAgainst:
                bounds === null
                    ? { min: Number.NaN, max: Number.NaN }
                    : { min: bounds.kcalRange.min, max: bounds.kcalRange.max },
            kcalReviewRangeByFoodStateMeasuredAgainst: sortedRecord(byFoodState),
            energyMacroTolerancePercentMeasuredAgainst: bounds === null ? Number.NaN : bounds.energyMacroTolerancePercent,
        };
    });

    // Sorted by category code, not by the plan's declaration order: a rerun
    // against unchanged data must produce byte-identical artefacts.
    return [...rows].sort((left, right) => compareStrings(left.category, right.category));
};

/**
 * The per-category quarantine figures, which both artefacts state and which
 * `reconcileQuarantineFigures` compares across them.
 *
 * Every plan category appears, including the ones with none, so a zero is
 * visibly a measured zero rather than a missing key; a category the plan does
 * not declare appears too when it holds quarantined rows, because dropping it
 * would understate the catalog's quarantine.
 */
export const quarantinePerCategory = (
    rows: readonly CoverageRow[],
    measurement: CatalogMeasurement,
): Record<string, number> => {
    const perCategory = emptyCounts();
    for (const row of rows) {
        perCategory[row.category] = row.quarantined;
    }
    for (const [category, count] of Object.entries(measurement.quarantinedByCategory)) {
        perCategory[category] = count;
    }
    return sortedRecord(perCategory);
};

/**
 * The per-category count of rows holding one publication status.
 *
 * Every plan category appears — a category with none reports a measured zero
 * rather than a missing key, which is the difference between "none were
 * withheld here" and "this run did not look" — and a category the plan does not
 * declare appears too when it holds rows of that status, because dropping it
 * would understate what the catalog withheld.
 */
export const perCategoryByStatus = (
    rows: readonly CoverageRow[],
    measurement: CatalogMeasurement,
    status: string,
): Record<string, number> => {
    const perCategory = emptyCounts();

    for (const row of rows) {
        const category = ownValue(measurement.categories, row.category);
        perCategory[row.category] = category === undefined ? 0 : statusCount(category.byPublicationStatus, status);
    }

    for (const [category, measured] of Object.entries(measurement.categories)) {
        const count = statusCount(measured.byPublicationStatus, status);
        if (count > 0) {
            perCategory[category] = count;
        }
    }

    return sortedRecord(perCategory);
};

/** What each withholding status means, so the audit is readable without the policy docs. */
const WITHHELD_STATUS_MEANING: Readonly<Record<string, string>> = {
    candidate: 'imported or generated and not yet judged, or judged and left for a curator to classify. Never searchable.',
    quarantined: 'judged unusable as it stands. Re-validated on the next run, never published on an invented value.',
    rejected: 'a reject-tier check disqualified it. Never publishable.',
};

/** The fields every identity in the audit carries. */
const WITHHELD_IDENTITY_FIELDS: readonly string[] = [
    'sourceKey',
    'category',
    'foodState',
    'displayName',
    'identitySource',
    'outcome',
    'failingChecks',
    'failingCheckEvidence',
    'publicationStatus',
];

export interface WithheldIdentityAudit {
    readonly purpose: string;
    readonly statuses: readonly string[];
    readonly statusMeaning: Readonly<Record<string, string>>;
    readonly identityFields: readonly string[];
    /** Rows per withholding status, plus `withheldTotal` — measured over every row scanned. */
    readonly totals: Readonly<Record<string, number>>;
    readonly perCategory: Readonly<Record<string, Readonly<Record<string, number>>>>;
    readonly byCheck: Readonly<Record<string, Readonly<Record<string, number>>>>;
    readonly identities: Readonly<Record<string, readonly WithheldIdentity[]>>;
    readonly identityCap: number;
    readonly identitiesOmittedByCap: Readonly<Record<string, number>>;
    readonly identitiesListed: Readonly<Record<string, number>>;
    readonly everyWithheldIdentityListed: boolean;
    readonly listedIdentitiesWithNoFailingCheck: Readonly<Record<string, number>>;
    /**
     * Failed checks stated WITH their observed value and bound, per status —
     * counted over the listed identities, so it is directly comparable with
     * `failingChecksListed` below. A name without its judgement data cannot be
     * triaged, so the two figures being equal is the property this audit
     * claims.
     */
    readonly failingCheckEvidenceEntries: Readonly<Record<string, number>>;
    readonly failingChecksListed: Readonly<Record<string, number>>;
    /**
     * True only where every listed identity's evidence states exactly the
     * failing-check names that identity lists — computed per entry, not by
     * comparing the two totals, so a name lost on one row and gained on another
     * cannot cancel out.
     */
    readonly everyFailingCheckStatesItsEvidence: boolean;
    readonly measuredFrom: string;
    readonly note: string;
}

/**
 * The withheld-identity audit: what the catalog did not publish, why, and where.
 *
 * WHY IT EXISTS. A published count and a shortfall say how far the catalog is
 * from the plan; they do not say which rows were held back or what held them,
 * and an operator reading committed evidence cannot act on a shortfall without
 * that. Agent Action Plan §0.7.1's report requirement names the quarantined
 * list explicitly, and the same question applies to the two other statuses that
 * mean a row is not published: a candidate awaiting a judgement and a rejected
 * row are equally absent from every published figure.
 *
 * WHAT IT MEASURES AND WHAT IT DOES NOT. Every figure here is counted from the
 * rows this run scanned. The prose is generated from those figures — there is
 * no sentence in it that asserts a cause the run did not measure — and the
 * identity lists carry each row's own failing checks as the validator recorded
 * them, never a reason inferred here. Where the per-status cap left identities
 * out, the cap and the omitted count are stated in this same block.
 */
export const buildWithheldIdentityAudit = (
    rows: readonly CoverageRow[],
    measurement: CatalogMeasurement,
): WithheldIdentityAudit => {
    // Keyed by WITHHELD_STATUSES, which is a constant of this module and not
    // data — but built the same prototype-free way as the maps that ARE
    // data-keyed, so no plain `{}` is left here for a later edit to key on a
    // stored status. The per-category and per-check maps they hold are
    // data-keyed throughout.
    const totals = emptyCounts();
    const perCategory = emptyIndex<Record<string, number>>();
    const byCheck = emptyIndex<Record<string, number>>();
    const identities = emptyIndex<readonly WithheldIdentity[]>();
    const identitiesListed = emptyCounts();
    const listedIdentitiesWithNoFailingCheck = emptyCounts();
    const identitiesOmittedByCap = emptyCounts();
    const failingCheckEvidenceEntries = emptyCounts();
    const failingChecksListed = emptyCounts();
    let identitiesWhoseEvidenceDisagrees = 0;

    const checksOfStatus = (status: string): Record<string, number> => {
        if (status === QUARANTINED) {
            return measurement.quarantinedByCheck;
        }
        if (status === REJECTED) {
            return measurement.rejectedByCheck;
        }
        return measurement.candidateByCheck;
    };

    let withheldTotal = 0;
    for (const status of WITHHELD_STATUSES) {
        const total = statusCount(measurement.byPublicationStatus, status);
        withheldTotal += total;
        totals[status] = total;
        perCategory[status] = perCategoryByStatus(rows, measurement, status);
        byCheck[status] = sortedRecord(checksOfStatus(status));

        const listed = measurement.withheldIdentities.filter((entry) => entry.publicationStatus === status);
        identities[status] = listed;
        identitiesListed[status] = listed.length;
        listedIdentitiesWithNoFailingCheck[status] = listed.filter(
            (entry) => entry.failingChecks.length === 0,
        ).length;
        identitiesOmittedByCap[status] = ownCount(measurement.withheldIdentitiesOmitted, status);

        // Counted per entry, and the agreement checked per entry: a report that
        // compared only the two totals would pass a set where one row lost a
        // name and another gained one.
        let evidenceEntries = 0;
        let namesListed = 0;
        for (const entry of listed) {
            evidenceEntries += entry.failingCheckEvidence.length;
            namesListed += entry.failingChecks.length;
            const evidenceNames = entry.failingCheckEvidence
                .map((check) => check.name)
                .sort(compareStrings)
                .join('\u0000');
            if (evidenceNames !== [...entry.failingChecks].sort(compareStrings).join('\u0000')) {
                identitiesWhoseEvidenceDisagrees += 1;
            }
        }
        failingCheckEvidenceEntries[status] = evidenceEntries;
        failingChecksListed[status] = namesListed;
    }
    totals.withheldTotal = withheldTotal;

    const listedTotal = WITHHELD_STATUSES.reduce((total, status) => total + ownCount(identitiesListed, status), 0);
    const omittedTotal = WITHHELD_STATUSES.reduce((total, status) => total + ownCount(identitiesOmittedByCap, status), 0);

    const perStatusPhrase = WITHHELD_STATUSES.map(
        (status) => `${formatCount(ownCount(totals, status))} ${status}`,
    ).join(', ');
    const noFailingCheckTotal = WITHHELD_STATUSES.reduce(
        (total, status) => total + ownCount(listedIdentitiesWithNoFailingCheck, status),
        0,
    );
    const evidenceEntriesTotal = WITHHELD_STATUSES.reduce(
        (total, status) => total + ownCount(failingCheckEvidenceEntries, status),
        0,
    );
    const namesListedTotal = WITHHELD_STATUSES.reduce(
        (total, status) => total + ownCount(failingChecksListed, status),
        0,
    );
    const everyFailingCheckStatesItsEvidence = identitiesWhoseEvidenceDisagrees === 0;

    return {
        purpose:
            'What the catalog withheld and why: the identity of every row that is not published, the checks that ' +
            'failed on it, and the per-category split of each withholding status. A shortfall cannot be acted on ' +
            'from a total alone.',
        statuses: WITHHELD_STATUSES,
        statusMeaning: WITHHELD_STATUS_MEANING,
        identityFields: WITHHELD_IDENTITY_FIELDS,
        totals: sortedRecord(totals),
        perCategory,
        byCheck,
        identities,
        identityCap: WITHHELD_IDENTITY_LIMIT,
        identitiesOmittedByCap: sortedRecord(identitiesOmittedByCap),
        identitiesListed: sortedRecord(identitiesListed),
        everyWithheldIdentityListed: omittedTotal === 0 && listedTotal === withheldTotal,
        listedIdentitiesWithNoFailingCheck: sortedRecord(listedIdentitiesWithNoFailingCheck),
        failingCheckEvidenceEntries: sortedRecord(failingCheckEvidenceEntries),
        failingChecksListed: sortedRecord(failingChecksListed),
        everyFailingCheckStatesItsEvidence,
        measuredFrom:
            'catalog_foods.publication_status joined to catalog_validation_records for the failing checks, their ' +
            'observed values and bounds, and the outcome. Both the per-category split and the identities exist only in those tables, which is why a ' +
            'report derived from the committed release artefacts \u2014 which carry published rows only \u2014 can ' +
            'state neither.',
        // Every number in this sentence is one of the measured figures above.
        note:
            `${formatCount(withheldTotal)} row(s) are withheld from the published catalog: ${perStatusPhrase}. ` +
            `${formatCount(listedTotal)} identity(ies) are listed here with the checks that failed on them, and ` +
            `${formatCount(omittedTotal)} were left out by the ${formatCount(WITHHELD_IDENTITY_LIMIT)}-per-status ` +
            `cap. ${formatCount(noFailingCheckTotal)} listed identity(ies) carry no failing check at all, which is ` +
            'what a row awaiting a judgement or held by an identity or classification floor looks like rather than ' +
            `a row a check disqualified. ${formatCount(evidenceEntriesTotal)} failing check(s) are stated with the ` +
            `observed value and bound the validator recorded, against ${formatCount(namesListedTotal)} failing ` +
            `check name(s) listed, and every listed identity's evidence states exactly the names it lists: ` +
            `${everyFailingCheckStatesItsEvidence ? 'yes' : 'NO \u2014 see everyFailingCheckStatesItsEvidence'}.`,
    };
};

const describeVerdict = (input: {
    readonly scopedTo: string | null;
    readonly publishedItems: number;
    readonly requirementMet: boolean;
    readonly shortfallTotal: number;
    readonly categoriesBelowTarget: number;
    readonly categoryCount: number;
    readonly publishedTargetTotal: number;
    readonly quarantined: number;
}): string => {
    const parts: string[] = [];

    if (input.scopedTo !== null) {
        parts.push(
            `Scoped run: every figure in this artefact covers the ${input.scopedTo} category only, ` +
                'so it is partial evidence and cannot stand in for a whole-catalog report.',
        );
    }

    parts.push(
        input.requirementMet
            ? `The ${formatCount(REQUIRED_PUBLISHED_ITEMS)}-item requirement is met: ${formatCount(input.publishedItems)} ` +
              `published items exceed it by ${formatCount(input.publishedItems - REQUIRED_PUBLISHED_ITEMS)}.`
            : `UNMET REQUIREMENT: ${formatCount(input.publishedItems)} published items against the ` +
              `${formatCount(REQUIRED_PUBLISHED_ITEMS)} the feature requires — a shortfall of ` +
              `${formatCount(REQUIRED_PUBLISHED_ITEMS - input.publishedItems)} items. The figure is measured and stated ` +
              'exactly; it is not estimated, rounded, or offset against any surplus.',
    );

    parts.push(
        input.shortfallTotal === 0
            ? `All ${formatCount(input.categoryCount)} categories are at or above their publishedTarget, ` +
              `whose values sum to ${formatCount(input.publishedTargetTotal)}.`
            : `UNMET REQUIREMENT: ${formatCount(input.categoriesBelowTarget)} of ${formatCount(input.categoryCount)} ` +
              `categories are below their publishedTarget by ${formatCount(input.shortfallTotal)} items in total. ` +
              'A surplus in one category never offsets a deficit in another, because recipe eligibility draws on ' +
              'specific categories, so the per-category shortfall is reported as its own unmet requirement.',
    );

    parts.push(
        `${formatCount(input.quarantined)} quarantined row(s) are excluded from every published figure here, ` +
            'which is what keeps the shortfall truthful: a quarantined record is never published on an invented value.',
    );

    return parts.join(' ');
};

export interface RequirementBlock {
    readonly requiredPublishedItems: number;
    readonly requirementSource: string;
    readonly publishedItems: number;
    readonly requirementMet: boolean;
    readonly surplusAgainstRequirement: number;
    readonly shortfallAgainstRequirement: number;
    readonly itemsWithValidationRecord: number;
    readonly itemsWithoutValidationRecord: number;
    readonly publishedTargetTotal: {
        readonly statedInPlan: number;
        readonly sumOfCategories: number;
        readonly agrees: boolean;
    };
    readonly perCategoryShortfallTotal: number;
    readonly categoriesMeasured: number;
    readonly categoriesBelowTarget: number;
    readonly categoriesAtOrAboveTarget: number;
    /**
     * The whole-catalog per-category verdict: true only when EVERY measured
     * category meets its own publishedTarget.
     *
     * The conjunction of the per-category `unmet` flags and nothing else — it
     * is never softened by the aggregate 10,000-item requirement being met,
     * because the two are different requirements over the same rows.
     */
    readonly everyCategoryMeetsItsTarget: boolean;
    /**
     * The categories that do not, with the exact shortfall of each and the part
     * of it that no judgement over existing rows could close.
     */
    readonly categoriesUnmet: readonly {
        readonly category: string;
        readonly shortfall: number;
        readonly reachableCeiling: number;
        readonly shortfallBeyondEveryRowObtained: number;
    }[];
    /**
     * How the whole per-category shortfall divides, in rows: the part that could
     * be closed by resolving withholdings over rows already in the database,
     * and the part for which no row exists at all.
     *
     * Arithmetic over the per-category counts, stated here because it decides
     * what an operator does about an unmet target — triage the withheld
     * rows, or obtain more input — and because the shortfall total alone
     * cannot distinguish the two.
     */
    readonly shortfallComposition: {
        readonly total: number;
        readonly closableByResolvingWithheldRows: number;
        readonly beyondEveryRowObtained: number;
        readonly note: string;
    };
    readonly unmetRequirements: readonly { readonly code: string; readonly detail: string }[];
    readonly verdict: string;
}

/**
 * One unmet category as the requirement block states it.
 *
 * Declared once and used by both artefacts' requirement blocks, so the two
 * cannot state a different field set for the same category.
 */
const unmetCategoryEntry = (
    row: CoverageRow,
): { category: string; shortfall: number; reachableCeiling: number; shortfallBeyondEveryRowObtained: number } => ({
    category: row.category,
    shortfall: row.shortfall,
    reachableCeiling: row.reachableCeiling,
    shortfallBeyondEveryRowObtained: row.shortfallBeyondEveryRowObtained,
});

export const buildRequirementBlock = (input: {
    readonly plan: CoveragePlan;
    readonly measurement: CatalogMeasurement;
    readonly shortfall: CatalogCoverageShortfall;
    readonly rows: readonly CoverageRow[];
    readonly scopedTo: string | null;
}): RequirementBlock => {
    const { plan, measurement, shortfall, rows, scopedTo } = input;
    const publishedItems = shortfall.publishedTotal;
    const quarantined = statusCount(measurement.byPublicationStatus, QUARANTINED);
    const categoriesBelowTarget = rows.filter((row) => row.shortfall > 0).length;
    const requirementMet = publishedItems >= REQUIRED_PUBLISHED_ITEMS;

    // Stated as codes as well as prose: a release gate needs to read the
    // outcome without parsing a sentence, and an unmet requirement is the one
    // finding that must never be softened into a metric.
    const unmetRequirements: { code: string; detail: string }[] = [];
    if (!requirementMet) {
        unmetRequirements.push({
            code: 'published_items_below_requirement',
            detail:
                `${formatCount(publishedItems)} published items against the required ` +
                `${formatCount(REQUIRED_PUBLISHED_ITEMS)}: short by ` +
                `${formatCount(REQUIRED_PUBLISHED_ITEMS - publishedItems)}.`,
        });
    }
    // How the gap divides: rows that exist and are withheld, against rows that
    // were never obtained. Summed over the short categories only, because a
    // surplus elsewhere closes none of it.
    const beyondEveryRow = rows
        .filter((row) => row.unmet)
        .reduce(
            (totals, row) => ({
                closable: totals.closable + (row.shortfall - row.shortfallBeyondEveryRowObtained),
                beyond: totals.beyond + row.shortfallBeyondEveryRowObtained,
            }),
            { closable: 0, beyond: 0 },
        );

    if (shortfall.shortfallTotal > 0) {
        unmetRequirements.push({
            code: 'categories_below_published_target',
            detail:
                `${formatCount(categoriesBelowTarget)} categories short of their publishedTarget by ` +
                `${formatCount(shortfall.shortfallTotal)} items in total; the per-category figures are in ` +
                `categories[]. ${formatCount(beyondEveryRow.beyond)} of those items exceed every row obtained for ` +
                'their category, so they cannot be produced by any judgement over the rows already imported or ' +
                'generated.',
        });
    }
    if (scopedTo !== null) {
        unmetRequirements.push({
            code: 'scoped_report_is_partial_evidence',
            detail: `This run measured the ${scopedTo} category only, so no whole-catalog claim can be read from it.`,
        });
    }

    return {
        requiredPublishedItems: REQUIRED_PUBLISHED_ITEMS,
        requirementSource:
            'Agent Action Plan §0.1.1 (10,000 distinct published, validated catalog items). ' +
            `${COVERAGE_PLAN_RELATIVE_PATH} owns the per-category publishedTarget values, whose total carries ` +
            'slack over this requirement so late quarantines cannot put it at risk.',
        publishedItems,
        requirementMet,
        surplusAgainstRequirement: Math.max(0, publishedItems - REQUIRED_PUBLISHED_ITEMS),
        shortfallAgainstRequirement: Math.max(0, REQUIRED_PUBLISHED_ITEMS - publishedItems),
        itemsWithValidationRecord: publishedItems - measurement.publishedWithoutValidationRecord.length,
        itemsWithoutValidationRecord: measurement.publishedWithoutValidationRecord.length,
        publishedTargetTotal: {
            statedInPlan: plan.publishedTargetTotal,
            sumOfCategories: shortfall.publishedTargetTotal,
            agrees: scopedTo !== null ? false : plan.publishedTargetTotal === shortfall.publishedTargetTotal,
        },
        perCategoryShortfallTotal: shortfall.shortfallTotal,
        categoriesMeasured: rows.length,
        categoriesBelowTarget,
        categoriesAtOrAboveTarget: rows.length - categoriesBelowTarget,
        // Read off the per-category rows, so the flag and the rows cannot
        // disagree, and stated even when the aggregate requirement is met.
        everyCategoryMeetsItsTarget: rows.every((row) => !row.unmet),
        categoriesUnmet: rows.filter((row) => row.unmet).map(unmetCategoryEntry),
        shortfallComposition: {
            total: shortfall.shortfallTotal,
            closableByResolvingWithheldRows: beyondEveryRow.closable,
            beyondEveryRowObtained: beyondEveryRow.beyond,
            note:
                `Of ${formatCount(shortfall.shortfallTotal)} item(s) short across ` +
                `${formatCount(categoriesBelowTarget)} category(ies), ${formatCount(beyondEveryRow.closable)} ` +
                'could at most be closed by resolving a withholding over rows already in the database \u2014 the ' +
                'withheld identities and their failing checks say which \u2014 and ' +
                `${formatCount(beyondEveryRow.beyond)} exceed every row obtained for their category, so no ` +
                're-validation, bound change or curator pass can produce them. Rejected rows are excluded from the ' +
                'reachable ceiling because a reject-tier failure is never publishable. This is arithmetic over the ' +
                'per-category counts and asserts no cause; the counters that bear on one are in the import report.',
        },
        unmetRequirements,
        verdict: describeVerdict({
            scopedTo,
            publishedItems,
            requirementMet,
            shortfallTotal: shortfall.shortfallTotal,
            categoriesBelowTarget,
            categoryCount: rows.length,
            publishedTargetTotal: shortfall.publishedTargetTotal,
            quarantined,
        }),
    };
};

/** Field-level attribution, merged into whatever `producedBy` the artefact
 * already carries so the stage's own entries survive (see `mergeOwnedFields`). */
const mergeProducedBy = (existing: unknown, aggregate: Readonly<Record<string, unknown>>): Record<string, unknown> => {
    // Pruned on the way in for the same reason the sub-objects are: the
    // attribution block is where an earlier producer recorded HOW the aggregate
    // half was produced, and a preserved claim that it came from committed
    // files rather than from a database would contradict the
    // aggregateFieldsDerivedFrom written right beside it. The stageFields*
    // entries, which belong to the stage that wrote them, are not named in
    // SUPERSEDED_KEYS and survive untouched.
    const merged = pruneSupersededKeys('producedBy', asRecord(existing) ?? {});
    for (const key of Object.keys(aggregate)) {
        merged[key] = aggregate[key];
    }
    return merged;
};

const aggregateProducedBy = (ownedFieldNames: readonly string[]): Record<string, unknown> => ({
    aggregateFieldsCommand: 'npm run catalog:report',
    aggregateFieldsScript: `scripts/${STAGE}.ts`,
    aggregateFieldsOwned: [...ownedFieldNames].sort(compareStrings),
    aggregateFieldsDerivedFrom: [
        'catalog_foods (read-only)',
        'catalog_validation_records (read-only)',
        COVERAGE_PLAN_RELATIVE_PATH,
        EVIDENCE_ALLOWLIST_RELATIVE_PATH,
    ],
    aggregateFieldsAccess:
        'This stage only reads. It creates, updates and deletes no catalog row, so running it can never change the ' +
        'figures it reports.',
    aggregateFieldsDeterminism:
        'Every map is emitted in sorted key order and every array on a stated key, and this stage writes no ' +
        'wall-clock value, so a rerun against unchanged data produces a byte-identical artefact and a diff in ' +
        'review means the data changed. Timestamps already in the file belong to the stage that wrote them and are ' +
        'carried through untouched.',
    aggregateFieldsPreserved:
        'Fields this stage does not own are preserved exactly as found; it never rewrites another stage\u2019s counters.',
    // The one exception to the line above, written down so it is auditable from
    // the artefact: a key an earlier producer wrote whose question this stage
    // now MEASURES is removed rather than preserved, because preserving it
    // would leave a claim beside data that contradicts it. Counters belonging
    // to another stage are never on this list.
    aggregateFieldsSuperseded: supersededKeyPaths(),
    aggregateFieldsSupersededNote:
        'Keys removed on this write because this stage now measures what they asserted. Each is listed as ' +
        '<block>.<key>; scripts/catalog-report.ts SUPERSEDED_KEYS records what supersedes each one. Nothing else ' +
        'is removed \u2014 in particular no counter from catalog:import, catalog:generate or catalog:validate.',
});

/** A tuple list rather than an object literal, so the emitted key order is
 * explicit and `producedBy` can name the field set it belongs to. */
type OwnedEntries = [string, unknown][];

const withProducedBy = (entries: OwnedEntries, existingProducedBy: unknown, extraOwned: readonly string[]): OwnedEntries => {
    const ownedFieldNames = [...entries.map(([key]) => key), ...extraOwned];
    const target = entries.find(([key]) => key === 'producedBy');
    if (target !== undefined) {
        target[1] = mergeProducedBy(existingProducedBy, aggregateProducedBy(ownedFieldNames));
    }
    return entries;
};

const CHECK_TIER_MEANING = {
    reject: 'physically impossible values. A rejected candidate is never publishable.',
    quarantine: 'unusable until more data arrives. Re-validated on the next run, never published on an invented value.',
    review: 'plausible but atypical. The flag is recorded; a USDA-sourced record publishes with it.',
} as const;

const OBSERVATION_LEGEND = {
    name: 'The check, drawn from the vocabulary in checkVocabulary.',
    pass: 'Whether the record satisfied the bound.',
    observed: 'The value measured on this record.',
    bound: 'The value that observation was measured against, as recorded when the check ran.',
    tier: 'The check tier, which is what decides a failing record\u2019s disposition.',
    observedNullMeaning:
        'An explicit null observed means the check found nothing to report \u2014 no offending value exists on the ' +
        'record \u2014 and is never a stand-in for zero or for an unmeasured value.',
} as const;

const buildCheckVocabularyBlock = (plan: CoveragePlan, measurement: CatalogMeasurement, publishedItems: number): unknown => {
    const evaluatedOnEveryItem: string[] = [];
    const recordedOnSomeItems: string[] = [];
    for (const name of [...KNOWN_CHECK_NAMES].sort(compareStrings)) {
        const tally = ownValue(measurement.publishedChecks, name);
        if (tally === undefined || tally.evaluated === 0) {
            continue;
        }
        if (publishedItems > 0 && tally.evaluated === publishedItems) {
            evaluatedOnEveryItem.push(name);
            continue;
        }
        recordedOnSomeItems.push(name);
    }
    const notRecorded = [...KNOWN_CHECK_NAMES]
        .filter((name) => (ownValue(measurement.publishedChecks, name)?.evaluated ?? 0) === 0)
        .sort(compareStrings);

    const planQuarantineChecks = [...plan.quarantineChecks].sort(compareStrings);
    const derivedQuarantineChecks = [...CATALOG_QUARANTINE_CHECK_NAMES].sort(compareStrings);

    const vocabularyNames = [...KNOWN_CHECK_NAMES].sort(compareStrings);
    const itemsWithCompleteVocabulary = measurement.publishedItemsWithCompleteVocabulary;
    const itemsWithUnexplainedGap = measurement.publishedItemsWithUnexplainedGap;

    return {
        source: CHECK_VOCABULARY_SOURCE,
        vocabularySize: vocabularyNames.length,
        names: vocabularyNames,
        quarantineSubsetOwnedBy: `${COVERAGE_PLAN_RELATIVE_PATH} quarantineChecks`,
        // Measured, not assumed: catalog.logic derives its quarantine-tier
        // names from the tier map so a script can assert code and data agree,
        // and a disagreement would mean records grouped under a vocabulary the
        // plan does not describe.
        quarantineSubsetAgreesWithPlan:
            planQuarantineChecks.length === derivedQuarantineChecks.length &&
            planQuarantineChecks.every((name, index) => name === derivedQuarantineChecks[index]),
        tierMeaning: CHECK_TIER_MEANING,
        namesByTier: {
            reject: [...CATALOG_REJECT_CHECK_NAMES].sort(compareStrings),
            quarantine: derivedQuarantineChecks,
            review: [...CATALOG_REVIEW_CHECK_NAMES].sort(compareStrings),
        },
        evaluatedOnEveryPublishedItem: evaluatedOnEveryItem,
        recordedOnSomePublishedItems: recordedOnSomeItems,
        notRecordedOnAnyPublishedItem: notRecorded,
        notRecordedNote:
            'Which checks a run records is a property of that run, not of this aggregate, so no aggregate-level ' +
            'reason is inferred for a name recorded on no published item. Where the absence IS explainable it is ' +
            'explained per item instead, from that item\u2019s own facts, on its record under notApplicableChecks ' +
            'and in perItemCompleteness below \u2014 which is the only level at which such a reason is evidence ' +
            'rather than a generalisation.',
        unrecognisedCheckNames: sortedRecord(measurement.unrecognisedCheckNames),
        unrecognisedCheckNamesNote:
            'Check names found on a record that the vocabulary does not declare. They are counted and named rather ' +
            'than filed under a guessed tier, because a tier decides a row\u2019s disposition.',
        // THE COMPLETENESS CLAIM, COMPUTED. Every figure below is counted over
        // the published items; none of them is asserted. `perItemCompleteness`
        // is true only when EVERY item's recorded names plus the names its own
        // facts show could not apply cover the whole vocabulary — so a single
        // item with an unexplained absence makes it false and names the gap.
        perItemCompleteness: {
            scope: 'the published rows this run measured',
            itemsMeasured: publishedItems,
            recordedChecksPerItem: sortedRecord(measurement.publishedRecordedChecksPerItem),
            recordedChecksPerItemNote:
                'A distribution, not a single number: how many vocabulary checks each published item records, ' +
                'keyed by that count. One key means every item records the same number of checks.',
            notApplicableEntriesByCheck: sortedRecord(measurement.publishedNotApplicableByName),
            notApplicableEntriesByReasonCode: sortedRecord(measurement.publishedNotApplicableByReasonCode),
            notApplicableNote:
                'A not-applicable entry is evidence that the check could not have been evaluated on that item, ' +
                'derived from that item\u2019s own measured facts and carried on its record beside the checks. It ' +
                'never carries a pass, an observed value or a bound, because the validator evaluated nothing to ' +
                'observe.',
            itemsCarryingEveryCheckOrAnExplanation: itemsWithCompleteVocabulary,
            itemsWithAnUnexplainedAbsence: itemsWithUnexplainedGap,
            everyItemAccountsForEveryCheck: itemsWithUnexplainedGap === 0 && publishedItems > 0,
            unexplainedAbsencesByCheck: sortedRecord(measurement.publishedUnexplainedByName),
            unexplainedAbsenceExamples: measurement.publishedUnexplainedExamples,
            unexplainedAbsenceExampleCap: UNEXPLAINED_GAP_EXAMPLE_LIMIT,
            unexplainedAbsenceExamplesOmittedByCap: measurement.publishedUnexplainedExamplesOmitted,
            claim:
                publishedItems === 0
                    ? 'No published item was measured, so no completeness claim is made.'
                    : itemsWithUnexplainedGap === 0
                      ? `All ${formatCount(publishedItems)} published items account for all ` +
                        `${formatCount(vocabularyNames.length)} vocabulary checks: each name is either recorded on ` +
                        'the item or carried as a not-applicable entry whose reason is derived from that item\u2019s ' +
                        'own facts.'
                      : `UNMET: ${formatCount(itemsWithUnexplainedGap)} of ${formatCount(publishedItems)} published ` +
                        `items leave at least one of the ${formatCount(vocabularyNames.length)} vocabulary checks ` +
                        'neither recorded nor explained. The names and the item counts are in ' +
                        'unexplainedAbsencesByCheck; re-running npm run catalog:validate re-judges those rows under ' +
                        'the current check set.',
        },
    };
};

const buildBoundsBlock = (plan: CoveragePlan): unknown => {
    // Keyed by the plan's category codes, which are data in a file on disk.
    const kcalReviewRangeByCategory = emptyIndex<unknown>();
    const energyMacroTolerancePercentByCategory = emptyCounts();
    for (const category of plan.categories) {
        const byFoodState = category.kcalReviewRangeByFoodState;
        kcalReviewRangeByCategory[category.category] = {
            min: category.kcalReviewRange.min,
            max: category.kcalReviewRange.max,
            ...(byFoodState === undefined ? {} : { byFoodState: sortedRecord(byFoodState as Record<string, unknown>) }),
        };
        energyMacroTolerancePercentByCategory[category.category] = category.energyMacroTolerancePercent;
    }

    return {
        note:
            'These are the values the recorded observations were measured against, reproduced so a reader can check ' +
            `an observation without opening another file. ${COVERAGE_PLAN_RELATIVE_PATH} owns them; the ` +
            'authoritative per-observation value is the bound on each item\u2019s own check entry.',
        policySource: COVERAGE_PLAN_RELATIVE_PATH,
        coveragePlanVersion: plan.coveragePlanVersion,
        global: {
            maxKcalPer100g: plan.validationBounds.maxKcalPer100g,
            macroMassToleranceFactor: plan.validationBounds.macroMassToleranceFactor,
            energyMacroAbsoluteToleranceKcal: plan.validationBounds.energyMacroAbsoluteToleranceKcal,
            portionConversionTolerancePercent: plan.validationBounds.portionConversionTolerancePercent,
        },
        energyMacroBoundFormula:
            'max(energyMacroAbsoluteToleranceKcal, category energyMacroTolerancePercent % of the stated kcal)',
        kcalReviewRangeByCategory: sortedRecord(kcalReviewRangeByCategory),
        kcalReviewRangeByFoodStateNote:
            'grain and legume publish both dry and cooked forms whose plausible energy bands do not overlap, so ' +
            'those categories override the category-wide band per food state. categories[] states the band each ' +
            'category\u2019s own published food states resolved to.',
        energyMacroTolerancePercentByCategory: sortedRecord(energyMacroTolerancePercentByCategory),
    };
};

const CATEGORIES_LEGEND = {
    publishedTarget: `The category\u2019s publishedTarget in ${COVERAGE_PLAN_RELATIVE_PATH}.`,
    candidateVolume: `The category\u2019s candidateVolume in ${COVERAGE_PLAN_RELATIVE_PATH}, ceil(1.25 x publishedTarget).`,
    published: 'Measured: rows whose publication_status is published.',
    shortfall: 'max(0, publishedTarget - published), exact and never rounded.',
    unmet:
        'Measured: true when this category\u2019s shortfall is above zero. A per-category target is its own ' +
        'requirement \u2014 recipe eligibility draws on specific categories \u2014 so a surplus in another category ' +
        'never clears it.',
    quarantined:
        'Measured from catalog_foods, which is the only place the split by category exists \u2014 the committed ' +
        'release artefacts carry published rows only, so a report derived from them states this as unmeasured.',
    candidate: 'Measured: rows still awaiting a judgement from catalog:validate.',
    rejected: 'Measured: rows a reject-tier check disqualified. Never publishable.',
    retired: 'Measured: rows a newer release no longer contains. Still referenceable, never searchable.',
    itemsWithRejectTierFailure: 'Published items carrying a failing reject-tier check. Zero unless the catalog is corrupt.',
    itemsWithQuarantineTierFailure: 'Published items carrying a failing quarantine-tier check.',
    itemsWithReviewTierFailure: 'Published items carrying at least one review flag, which publish by definition of the tier.',
    reviewFailuresByCheck: 'The same items counted per review check; an item can carry more than one flag.',
    quarantinedByCheck: 'Quarantined rows in this category counted by the check that held them.',
    foodStates: 'Published items by food_state; raw, dry and cooked forms never merge.',
    kcalReviewRangeMeasuredAgainst: 'The category-wide band the out_of_category_range observations were measured against.',
    kcalReviewRangeByFoodStateMeasuredAgainst:
        'The band each food state present in this category resolved to, and whether a per-food-state override supplied it.',
} as const;

const ITEM_RECORD_FIELDS: readonly string[] = [
    'sourceKey',
    'canonicalIdentity',
    'aliases',
    'category',
    'foodState',
    'identitySource',
    'identityStatus',
    'nutritionProvenance',
    'nutritionMethod',
    'nutritionAssumptions',
    'portionUnits',
    'identityEvidence',
    'checks',
    'llmReview',
    'outcome',
    'publicationStatus',
    'reviewedAt',
    'sourceVersions',
    'notApplicableChecks',
];

/** The fields a not-applicable entry carries — no pass, no observed, no bound. */
const NOT_APPLICABLE_FIELDS: readonly string[] = ['name', 'tier', 'applicable', 'reasonCode', 'reason'];

export const buildValidationReportEntries = (input: {
    readonly plan: CoveragePlan;
    readonly policy: CatalogValidationPolicy;
    readonly allowlistVersion: string;
    readonly evidenceRegistrySnapshot: string;
    readonly measurement: CatalogMeasurement;
    readonly shortfall: CatalogCoverageShortfall;
    readonly rows: readonly CoverageRow[];
    readonly requirement: RequirementBlock;
    readonly scopedTo: string | null;
    readonly existing: Readonly<Record<string, unknown>> | null;
}): OwnedEntries => {
    const { plan, allowlistVersion, evidenceRegistrySnapshot, measurement, shortfall, rows, requirement, scopedTo } = input;
    const publishedItems = shortfall.publishedTotal;

    const failuresByTier = (tier: string): Record<string, number> => {
        const byCheck = emptyCounts();
        for (const [name, tally] of Object.entries(measurement.publishedChecks)) {
            if (tally.tier === tier && tally.failed > 0) {
                byCheck[name] = tally.failed;
            }
        }
        return sortedRecord(byCheck);
    };

    const itemsWithTierFailure = (pick: (category: CategoryMeasurement) => number): number =>
        Object.values(measurement.categories).reduce((total, category) => total + pick(category), 0);

    const checksByCheck = emptyIndex<unknown>();
    for (const [name, tally] of Object.entries(measurement.publishedChecks)) {
        checksByCheck[name] = { tier: tally.tier, evaluated: tally.evaluated, passed: tally.passed, failed: tally.failed };
    }

    const entries: OwnedEntries = [
        ['reportVersion', REPORT_VERSION],
        ['reportKind', VALIDATION_REPORT_KIND],
        [
            'purpose',
            'Acceptance evidence that every published catalog food carries a machine-readable validation record, with ' +
                'the observed value and the bound it was measured against for every check, and with an explicit ' +
                'not-applicable entry for every check name the item\u2019s own facts show could not be evaluated on ' +
                'it. The rows the catalog withheld are named in withheldIdentityAudit with the checks that failed on ' +
                'them. This artefact records what was measured; the bounds, tiers and category targets it measures ' +
                `against are owned by ${COVERAGE_PLAN_RELATIVE_PATH} and are cited, not restated as policy here.`,
        ],
        ['producedBy', null],
        [
            'scope',
            {
                stage: STAGE,
                measuredFrom: 'catalog_foods joined to catalog_validation_records, read-only',
                databaseUrlEnvVar: DATABASE_URL_ENV,
                environmentValuesRecorded:
                    'none \u2014 this artefact records environment variable names only, never their values',
                categoryFilter: scopedTo,
                rowsScanned: measurement.rowsScanned,
                rowsWithValidationRecord: measurement.rowsWithValidationRecord,
                byPublicationStatus: sortedRecord(measurement.byPublicationStatus),
                itemRecordScope:
                    'The per-item records cover the published rows. Quarantined, rejected, candidate and retired rows ' +
                    'are counted here and the quarantined ones are named in the quarantine block, but they carry no ' +
                    'per-item record: this artefact is the evidence for what the catalog publishes.',
                unknownCategories: [...shortfall.unknownCategories].sort(compareStrings),
                unknownCategoriesNote:
                    'Categories the rows carry that the coverage plan does not declare. Their published rows are ' +
                    'excluded from the totals, because a total that absorbed them would report a catalog larger than ' +
                    'the plan describes.',
            },
        ],
        ['requirement', requirement],
        [
            'policy',
            {
                policySource: COVERAGE_PLAN_RELATIVE_PATH,
                coveragePlanVersion: plan.coveragePlanVersion,
                publishedTargetTotalStatedInPlan: plan.publishedTargetTotal,
                candidateVolumeTotalStatedInPlan: plan.candidateVolumeTotal ?? null,
                generationPromptVersion: plan.promptVersion,
                reviewPromptVersion: plan.reviewPromptVersion,
                checkVocabularySource: CHECK_VOCABULARY_SOURCE,
                evidenceAllowlistSource: EVIDENCE_ALLOWLIST_RELATIVE_PATH,
                evidenceAllowlistVersion: allowlistVersion,
                evidenceRegistrySnapshot,
                note:
                    'The identifiers of the policy the recorded checks ran under. Reproduced so this evidence can be ' +
                    'tied to the exact documents in force at the time; none of it is authored here.',
            },
        ],
        ['checkVocabulary', buildCheckVocabularyBlock(plan, measurement, publishedItems)],
        ['boundsMeasuredAgainst', buildBoundsBlock(plan)],
        ['observationLegend', OBSERVATION_LEGEND],
        [
            'tierRollup',
            {
                scope: 'the published rows this run measured',
                itemsMeasured: publishedItems,
                itemsWithNoFailingCheck: measurement.publishedItemsWithNoFailingCheck,
                itemsWithMoreThanOneReviewFailure: measurement.publishedItemsWithBothReviewFlags,
                reject: {
                    itemsWithFailure: itemsWithTierFailure((category) => category.publishedItemsWithRejectFailure),
                    failuresByCheck: failuresByTier('reject'),
                    note:
                        'Expected to be zero: a record failing a reject-tier check is never published, so a non-zero ' +
                        'figure here is a corrupt catalog rather than a tolerance to widen. The reject-tier failures ' +
                        'the pipeline did find are counted by the stage that found them, in the import report.',
                },
                quarantine: {
                    itemsWithFailure: itemsWithTierFailure((category) => category.publishedItemsWithQuarantineFailure),
                    failuresByCheck: failuresByTier('quarantine'),
                    note:
                        'Expected to be zero for the same reason. The quarantined rows are counted and named in the ' +
                        'quarantine block below, where they are excluded from every published figure.',
                },
                review: {
                    itemsWithFailure: itemsWithTierFailure((category) => category.publishedItemsWithReviewFailure),
                    failuresByCheck: failuresByTier('review'),
                    note:
                        'A review-tier flag is recorded and the record publishes, which is the tier\u2019s definition ' +
                        'and why these counts can be large without any item being lost.',
                },
            },
        ],
        [
            'checksOverPublishedItems',
            {
                scope: 'the published rows this run measured',
                checkEntriesRecorded: measurement.publishedCheckEntries,
                byCheck: sortedRecord(checksByCheck),
                // MEASURED, never asserted: true only when no published item
                // leaves a vocabulary name both unrecorded and unexplained.
                // `evaluated` above counts the items a check RAN on, which is a
                // different question — a name absent from an item because its
                // precondition was not met is accounted for by the
                // not-applicable evidence, and the two are reconciled in
                // checkVocabulary.perItemCompleteness.
                everyItemCarriesEveryCheck:
                    measurement.publishedItemsWithUnexplainedGap === 0 && publishedItems > 0,
                everyItemCarriesEveryCheckMeaning:
                    'For every published item, each of the vocabulary\u2019s checks is either recorded on that ' +
                    'item with its observation and bound, or carried on it as a not-applicable entry whose reason ' +
                    'is derived from that item\u2019s own measured facts. The per-check, per-reason and ' +
                    'per-unexplained-name figures behind this flag are in checkVocabulary.perItemCompleteness.',
                itemsWithAnUnexplainedAbsence: measurement.publishedItemsWithUnexplainedGap,
            },
        ],
        ['categoriesLegend', CATEGORIES_LEGEND],
        ['categories', rows],
        [
            'quarantine',
            {
                total: statusCount(measurement.byPublicationStatus, QUARANTINED),
                byCheck: sortedRecord(measurement.quarantinedByCheck),
                perCategory: quarantinePerCategory(rows, measurement),
                perCategoryMeasuredFrom:
                    'catalog_foods.publication_status grouped by category \u2014 measured, not estimated, and not ' +
                    'recoverable from the committed release artefacts, which carry published rows only.',
                countsTowardPublishedTarget: false,
                identities: measurement.quarantinedIdentities,
                identityCap: WITHHELD_IDENTITY_LIMIT,
                identitiesOmittedByCap: measurement.withheldIdentitiesOmitted[QUARANTINED] ?? 0,
                identitiesNote:
                    'One entry per quarantined row, sorted by source key, each carrying the checks that failed on ' +
                    'it as the validator recorded them. The candidate and rejected rows are listed the same way in ' +
                    'withheldIdentityAudit; total above is measured over every scanned row whether or not the cap ' +
                    'listed it.',
                whyTheShortfallStaysTruthful:
                    'A quarantined record is never published on an invented value, so it is excluded from every ' +
                    'published count and from the coverage figures. That is what makes the per-category shortfall the ' +
                    'honest distance to the plan rather than a number inflated by unusable rows.',
            },
        ],
        ['withheldIdentityAudit', buildWithheldIdentityAudit(rows, measurement)],
        [
            'provenance',
            {
                note:
                    'Four independent facts, never collapsed into one mixed field: where the identity came from, how ' +
                    'far it was verified, how the nutrition was arrived at, and whether the food is published. Keeping ' +
                    'them apart is what lets a record say "USDA identity, ingredient-derived nutrition, published" ' +
                    'without either claim contaminating the other.',
                scope: 'the published rows this run measured',
                identitySource: sortedRecord(measurement.publishedByIdentitySource),
                identityStatus: sortedRecord(measurement.publishedByIdentityStatus),
                nutritionProvenance: sortedRecord(measurement.publishedByNutritionProvenance),
                outcome: sortedRecord(measurement.publishedByOutcome),
                foodState: sortedRecord(measurement.publishedByFoodState),
                usdaDataType: sortedRecord(measurement.publishedByUsdaDataType),
                usdaDataTypeNoneMeaning: `"${NO_USDA_DATA_TYPE}" counts published foods with no USDA data type, which is what an AI-generated identity carries.`,
                recipeEligibilityConsequence:
                    'Recipe planning admits source_backed ingredients only, so any ingredient_derived or ai_estimated ' +
                    'count above is a count of foods that are searchable and labelled as estimates but never planned.',
            },
        ],
        [
            'nutritionMethodBreakdown',
            {
                scope: 'the published rows this run measured',
                byMethod: sortedRecord(measurement.publishedByNutritionMethod),
                byMethodNote:
                    'Keyed by the exact nutrition_method text each record stores, so the figures group what the ' +
                    'validator actually wrote rather than a bucketing inferred from it here.',
                nutritionBasis: sortedRecord(measurement.publishedByNutritionBasis),
            },
        ],
        [
            'identityEvidenceSummary',
            {
                scope: 'the published rows this run measured',
                retrievalRecords: measurement.publishedEvidenceRecords,
                recordsPerItem: sortedRecord(measurement.publishedEvidenceRecordsPerItem),
                itemsWithNoEvidence: measurement.publishedItemsWithoutEvidence,
                itemsWithNoEvidenceNote:
                    'A published food with no retrieval record is a gap in identity evidence. The unsourced check is ' +
                    'what holds such a candidate in quarantine, so a non-zero figure here is worth investigating.',
            },
        ],
        [
            'advisoryReview',
            {
                itemsWithLlmReview: measurement.publishedItemsWithAdvisoryReview,
                note:
                    'The advisory review is recorded and never promotes a value: it can confirm a flag, and it is ' +
                    'never presented as verified nutrition. A null llm_review is the honest value for a review that ' +
                    'did not happen.',
            },
        ],
        [
            'integrityReconciliation',
            {
                publishedItemsWithoutValidationRecord: measurement.publishedWithoutValidationRecord.length,
                publishedItemsWithoutValidationRecordNote:
                    'Zero here is asserted, not hoped for: the run fails and names the identities rather than ' +
                    'emitting a report that is silently short of records.',
                publishedIdentityCollisions: measurement.publishedIdentityCollisions,
                publishedIdentityCollisionsNote:
                    'Published rows sharing a canonical name and food state. The partial unique index on ' +
                    '(canonical_name, food_state) WHERE publication_status = \u2018published\u2019 should make this ' +
                    'impossible, so the list is an integrity check on the database rather than an expected finding.',
                recordFieldMismatchCount: measurement.recordFieldMismatchCount,
                recordFieldMismatches: measurement.recordFieldMismatches,
                recordFieldMismatchNote:
                    'A validation record mirrors its food\u2019s category, food state, identity source, identity ' +
                    'status, nutrition provenance and publication status. A disagreement means the record was judged ' +
                    'against facts the food no longer carries, which would make the per-category evidence wrong.',
                aliasRecordsOnPublishedItems: measurement.publishedAliasRecords,
            },
        ],
        [
            'measurementGaps',
            [
                {
                    field:
                        'the PASSING checks, identity evidence and portions of quarantined, rejected, candidate ' +
                        'and retired rows',
                    value: null,
                    reason:
                        'The full per-item record \u2014 every check passing and failing, the identity evidence and ' +
                        'the portions \u2014 is carried for published rows, which is what the catalog serves. For a ' +
                        'withheld row, withheldIdentityAudit carries its identity, its category, its outcome and ' +
                        'every FAILING check WITH the observed value and bound the validator recorded, which is ' +
                        'what the withholding has to be read from; the checks that passed on it are not restated, ' +
                        'because they did not contribute to it. The quarantined rows appear again, identically, in ' +
                        'the quarantine block. A retired row was published by an earlier release and is counted per ' +
                        'category rather than filed as withheld.',
                },
                {
                    field: 'the cause of any per-category shortfall',
                    value: null,
                    reason:
                        'This stage measures the DISTANCE to each target and states it exactly; it measures nothing ' +
                        'about why the distance exists and therefore names no cause. The counters that bear on one ' +
                        '\u2014 candidates imported and refused, generation batches planned and executed, identity ' +
                        'evidence verified \u2014 belong to catalog:import and catalog:generate and are preserved as ' +
                        'those stages wrote them in reports/latest/import-report.json. A cause asserted here would ' +
                        'be an inference wearing a measurement\u2019s clothes.',
                },
                {
                    field: 'stage counters from the catalog:validate run',
                    value: null,
                    reason:
                        'Fields such as counts, failedChecks and reviewFlags belong to the validate run and are ' +
                        'preserved exactly as that stage wrote them. They count the candidates that pass considered, ' +
                        'which is a different row set from the published rows measured here, so the same check name ' +
                        'can carry two different figures in this file and neither is adjusted to match the other.',
                },
            ],
        ],
        [
            'itemRecords',
            {
                count: publishedItems - measurement.publishedWithoutValidationRecord.length,
                keyedBy: 'sourceKey',
                keyFormat:
                    'usda:<fdcId> for an imported record, ai:<category>:<canonicalName>:<foodState> for a generated one',
                keyNote:
                    'The stable source key, never a database uuid: a uuid is environment-local, so evidence keyed by ' +
                    'one could not be reproduced against a second independently loaded database.',
                order: 'ascending by sourceKey',
                oneRecordPerPublishedFood: true,
                fields: ITEM_RECORD_FIELDS,
                casing:
                    'Keys are camelCase because this is evidence read off the wire side of the contract, while the ' +
                    'same facts are snake_case in the database and in the release JSONL. The translation happens here ' +
                    'and only here. Enum values keep their stored form, so a value stays greppable against both.',
                recordedChecksPerItem: sortedRecord(measurement.publishedRecordedChecksPerItem),
                recordedChecksPerItemNote:
                    'How many vocabulary checks each record carries, as a distribution keyed by that count \u2014 ' +
                    'not a single number, which an aggregate can only state when every item happens to agree. The ' +
                    'names an item does not record are accounted for on the record itself, under ' +
                    'notApplicableChecks.',
                notApplicableChecksField: NOT_APPLICABLE_FIELDS,
                notApplicableChecksNote:
                    'Beside each record\u2019s checks, one entry per vocabulary name the item\u2019s own facts show ' +
                    'the validator could not evaluate. It carries applicable: false and a reason and never a pass, ' +
                    'an observed value or a bound \u2014 nothing here invents a verdict the validator did not reach.',
                identityEvidenceProjection: IDENTITY_EVIDENCE_FIELDS,
                identityEvidenceProjectionNote:
                    'Each retrieval record is projected to these fields. The request body and cache key the ' +
                    'importer also stores are deliberately left out: they are bulky, they repeat per item, and none ' +
                    'of them is part of the identity claim being evidenced.',
            },
        ],
    ];

    return withProducedBy(entries, input.existing === null ? null : input.existing.producedBy, [ITEMS_KEY]);
};

/**
 * The retrieval-record fields each item's identity evidence is projected to.
 *
 * The importer also stores the request body, the cache key and a subject line
 * per hash. They are bulky, they repeat per item — a USDA detail batch carries
 * twenty FDC ids — and none of them is part of the identity claim, so the
 * projection stops here instead of turning the artefact into a request log.
 */
const IDENTITY_EVIDENCE_FIELDS: readonly string[] = [
    'url',
    'method',
    'finalHost',
    'httpStatus',
    'bodySha256',
    'recordSha256',
    'matchedSnippet',
    'fetchedAt',
    'retrievalSource',
    'allowlistClass',
];

const projectEvidence = (entry: unknown): unknown => {
    const camelized = asRecord(camelizeKeys(entry));
    if (camelized === null) {
        return entry;
    }
    const projected = emptyIndex<unknown>();
    for (const field of IDENTITY_EVIDENCE_FIELDS) {
        // Only fields the record actually states: an absent field left absent
        // says "the retrieval did not record this", while a manufactured null
        // would claim it was recorded as unknown.
        if (Object.prototype.hasOwnProperty.call(camelized, field)) {
            projected[field] = camelized[field];
        }
    }
    return projected;
};

const checkNameOf = (entry: unknown): string => {
    const record = asRecord(entry);
    return record !== null && typeof record.name === 'string' ? record.name : '';
};

/** One published food's validation record, on the wire side of the contract. */
export const toItemRecord = (row: ReportFoodRow, record: ValidationRecordRow): Record<string, unknown> => ({
    sourceKey: row.source_key,
    canonicalIdentity: camelizeKeys(record.canonical_identity),
    aliases: [...record.aliases].sort(compareStrings),
    category: record.category,
    foodState: record.food_state,
    identitySource: record.identity_source,
    identityStatus: record.identity_status,
    nutritionProvenance: record.nutrition_provenance,
    nutritionMethod: record.nutrition_method,
    nutritionAssumptions: parseStoredAssumptions(record.nutrition_assumptions),
    portionUnits: camelizeKeys(record.portion_units),
    identityEvidence: asArray(record.identity_evidence).map((entry) => projectEvidence(entry)),
    // Sorted by check name so the array order is a property of the evidence
    // rather than of the order the validator happened to record it in.
    checks: [...asArray(record.checks)]
        .map((entry) => camelizeKeys(entry))
        .sort((left, right) => compareStrings(checkNameOf(left), checkNameOf(right))),
    llmReview: record.llm_review === undefined ? null : camelizeKeys(record.llm_review),
    outcome: record.outcome,
    publicationStatus: record.publication_status,
    reviewedAt: isoDate(record.reviewed_at),
    sourceVersions: camelizeKeys(record.source_versions),
    // Computed from the same facts the aggregate pass measured, so the per-item
    // evidence and checkVocabulary.perItemCompleteness cannot disagree about
    // this item: every vocabulary name is either in `checks` above, as the
    // validator wrote it, or here with the reason it could not be evaluated.
    notApplicableChecks: notApplicableChecksForItem(publishedItemFacts(row, record)).notApplicable,
});

// ---------------------------------------------------------------------------
// The import report's aggregate half.
//
// Merged into, never over: every other field in that file — the planned and
// processed batch counts, the per-category candidate figures, the USDA request
// accounting, the model spend — is the import stage's own measurement, and this
// stage has no way to measure any of it. Blocks that mix the two (the check
// failures, the quarantine figures, the sibling reconciliation) are merged one
// sub-key at a time for the same reason, and the one array this stage would
// otherwise have to overwrite gets a key of its own instead, because two arrays
// cannot be merged without deciding which entries mean the same thing.
// ---------------------------------------------------------------------------

const subObjectOf = (existing: Readonly<Record<string, unknown>> | null, key: string): Record<string, unknown> => {
    const block = existing === null ? null : asRecord(ownValue(existing, key));
    return block === null ? emptyIndex<unknown>() : copyOwnEntries(block);
};

/* ---------------------------------------------------------------------------
 * Superseded keys — the reason a regenerated report cannot carry a contradicted
 * claim.
 *
 * THE MECHANISM THIS CLOSES. A sub-object is merged one key at a time, so this
 * stage's measurements land on the keys it owns and every other key keeps its
 * value — which is exactly right for another stage's COUNTER and exactly wrong
 * for a CLAIM an earlier producer wrote about data this stage now measures. A
 * sentence saying the quarantined identities are unavailable survives beside
 * the identities; `checksPerItem: 13` survives beside a measured distribution;
 * `everyItemCarriesEveryCheck: true` survives beside the computed flag that
 * says otherwise. The artefact then reads as consistent while asserting the
 * opposite of what it shows, which is worse than either alone.
 *
 * WHY A NAMED LIST AND NOT A WIPE. A blanket "drop what I do not own" would
 * take the import stage's `usdaRequests` and `modelSpend`, the validate stage's
 * `counts`, `failedChecks` and `duplicateIdentities`, and the per-stage
 * quarantine attribution (`atImport`, `atValidate`) — figures this stage cannot
 * measure and must never restate. So each removal is written down with what
 * supersedes it, and anything not named here survives the merge untouched.
 * ------------------------------------------------------------------------- */

interface SupersededKey {
    /** The key removed from the sub-object named by the entry it appears under. */
    readonly key: string;
    /** The field this stage now emits that answers the same question. */
    readonly supersededBy: string;
}

/**
 * Keys an earlier producer wrote that this stage's own measurements replace,
 * per sub-object. Keyed by the sub-object's name in the artefact, so a reader
 * can find the removal beside the block it applies to.
 */
const SUPERSEDED_KEYS: Readonly<Record<string, readonly SupersededKey[]>> = {
    quarantine: [
        // Superseded by the measured perCategory map: a reason saying the split
        // is unmeasurable cannot stand beside the split.
        { key: 'perCategoryUnmeasuredReason', supersededBy: 'quarantine.perCategory (measured per category)' },
        { key: 'identitiesUnavailableReason', supersededBy: 'quarantine.identities (measured, one entry per row)' },
        // Superseded by the validate stage's duplicateIdentityAccounting and by
        // withheldIdentityAudit: the note mixed lost identities, quarantined
        // rows and inserted alias rows in one sentence.
        {
            key: 'duplicateIdentityNote',
            supersededBy: 'duplicateIdentityAccounting (catalog:validate), each figure in its own unit',
        },
    ],
    quarantined: [
        { key: 'perCategoryUnmeasuredReason', supersededBy: 'quarantined.perCategory (measured per category)' },
        { key: 'identitiesUnavailableReason', supersededBy: 'quarantined.identities (measured, one entry per row)' },
        {
            key: 'duplicateIdentityNote',
            supersededBy: 'duplicateIdentityAccounting (catalog:validate), each figure in its own unit',
        },
    ],
    duplicatesRemoved: [
        {
            key: 'duplicateIdentityNote',
            supersededBy: 'duplicateIdentityAccounting (catalog:validate), each figure in its own unit',
        },
    ],
    checksOverPublishedItems: [
        {
            key: 'everyItemCarriesEveryCheck',
            supersededBy: 'the computed everyItemCarriesEveryCheck and checkVocabulary.perItemCompleteness',
        },
    ],
    checkVocabulary: [
        {
            key: 'evaluatedCount',
            supersededBy: 'checkVocabulary.vocabularySize and perItemCompleteness.recordedChecksPerItem',
        },
    ],
    itemRecords: [
        {
            key: 'checksPerItem',
            supersededBy: 'itemRecords.recordedChecksPerItem (a measured distribution, not a scalar)',
        },
    ],
    dataProvenance: [
        // The legal determination, its citations and the source-dataset
        // versions in this block are preserved untouched. These two are not
        // legal facts: one asserts the absence of generated content and the
        // other explains it with a claim about whether generation ran, which
        // the generation counters in the same artefact can contradict outright.
        {
            key: 'aiGeneratedContentPresent',
            supersededBy: 'dataProvenance.generatedContent (measured either side of the publication line)',
        },
        {
            key: 'aiGenerationPolicy',
            supersededBy:
                'dataProvenance.generatedContent.labellingConsequence and generationRefusalPolicy, which state ' +
                'the measured consequence and the standing refusal rule separately',
        },
    ],
    siblingReconciliation: [
        // THE ONE SUB-KEY THIS BLOCK CANNOT CARRY. This stage writes
        // `validationReport` — the reconciliation it can actually make, because
        // it writes both documents from one snapshot — and merges it over
        // whatever the block already held. `releaseManifest` was written by an
        // earlier producer and then carried by every later write, which made it
        // assert agreement between two artefacts that had moved apart:
        // measured on the regenerated pipeline it still read
        // `publishedFoodsThere: 9422`, `publishedFoodsHere: 9422`,
        // `publishedAgrees: true` and row counts 9,422 / 13,088 / 27,289,
        // beside a release manifest on disk stating 10,928 / 15,777 / 31,537
        // and this document's own `requirement.publishedItems: 10928`. An
        // asserted agreement is the worst shape for a stale claim to take: a
        // reader checking whether the release matches the report is answered
        // "yes" by a figure from a previous release.
        //
        // It is removed rather than re-derived because this stage reads no
        // release directory (producedBy.aggregateFieldsDerivedFrom names every
        // input it has) and, in the documented order, runs BEFORE the release
        // it would be reconciling against — so a release reconciliation here
        // could only ever describe a PREVIOUS release.
        {
            key: 'releaseManifest',
            supersededBy:
                'the release manifest\u2019s own coverage, acceptance and counts blocks, which catalog:release ' +
                'measures from the same catalog at export time, and search-benchmark\u2019s corpus.countChecks, ' +
                'which compares those counts with a loaded database',
        },
    ],
    producedBy: [
        // All three describe how the AGGREGATE half was produced, and all three
        // assert it came from the committed release artefacts rather than from a
        // database — which this stage's own aggregateFieldsDerivedFrom
        // contradicts. The stageFields* keys beside them belong to the stage
        // that wrote them and are untouched.
        { key: 'databaseIndependence', supersededBy: 'producedBy.aggregateFieldsDerivedFrom and aggregateFieldsAccess' },
        { key: 'itemRecordSource', supersededBy: 'producedBy.aggregateFieldsDerivedFrom' },
        { key: 'regenerability', supersededBy: 'producedBy.aggregateFieldsDeterminism and aggregateFieldsPreserved' },
    ],
};

/** Every superseded key this stage prunes, as `<block>.<key>` — emitted in the
 * artefact so a removal is auditable from the file rather than only from here. */
export const supersededKeyPaths = (): readonly string[] =>
    Object.entries(SUPERSEDED_KEYS)
        .flatMap(([block, keys]) => keys.map((entry) => `${block}.${entry.key}`))
        .sort(compareStrings);

/**
 * Drops the keys {@link SUPERSEDED_KEYS} names for one sub-object.
 *
 * Exported for its unit test: the two properties that matter — the named key is
 * gone, and every key that is not named survives byte for byte — are exactly
 * what a test can pin and a reviewer cannot.
 */
export const pruneSupersededKeys = (
    blockName: string,
    block: Readonly<Record<string, unknown>>,
): Record<string, unknown> => {
    const superseded = ownValue(SUPERSEDED_KEYS, blockName) ?? [];
    // A prototype-free copy: the block came off the artefact on disk, where
    // `JSON.parse` keeps a `__proto__` key as an ordinary property, and this
    // function promises that every key it does not name survives byte for
    // byte — which a plain `{ ...block }` target would break for that one key.
    const pruned = copyOwnEntries(block);
    for (const entry of superseded) {
        delete pruned[entry.key];
    }
    return pruned;
};

const mergeSubObject = (
    existing: Readonly<Record<string, unknown>> | null,
    key: string,
    own: Readonly<Record<string, unknown>>,
): Record<string, unknown> => {
    const merged = pruneSupersededKeys(key, subObjectOf(existing, key));
    for (const ownKey of Object.keys(own)) {
        merged[ownKey] = own[ownKey];
    }
    return merged;
};

export interface QuarantineFigures {
    readonly total: number;
    readonly perCategory: Readonly<Record<string, number>>;
}

const IMPORT_REPORT_CATEGORY_FIELDS = [
    'publishedTarget',
    'candidateVolume',
    'published',
    'quarantined',
    'shortfall',
    // The per-category verdict travels with the per-category figures, in both
    // artefacts and on every row: a gate reading this file must not have to
    // re-derive it, and a row that carried the shortfall without the verdict is
    // how a deficit gets read as a metric.
    'unmet',
    'candidate',
    'rejected',
    'retired',
] as const;

/** Row-level merge: the import stage's per-category candidate, aiCandidate and
 * batch figures live on these same rows and must survive. */
const mergeCategoryRows = (
    existing: Readonly<Record<string, unknown>> | null,
    rows: readonly CoverageRow[],
): readonly unknown[] => {
    const existingRows = existing === null ? [] : asArray(existing.categories);
    const byCategory = new Map<string, Record<string, unknown>>();
    for (const entry of existingRows) {
        const record = asRecord(entry);
        if (record !== null && typeof record.category === 'string') {
            byCategory.set(record.category, { ...record });
        }
    }

    const merged: Record<string, unknown>[] = [];
    const covered = new Set<string>();
    for (const row of rows) {
        covered.add(row.category);
        const target = byCategory.get(row.category) ?? { category: row.category };
        for (const field of IMPORT_REPORT_CATEGORY_FIELDS) {
            target[field] = row[field];
        }
        merged.push(target);
    }
    for (const [category, record] of byCategory) {
        if (!covered.has(category)) {
            merged.push(record);
        }
    }

    return merged.sort((left, right) =>
        compareStrings(typeof left.category === 'string' ? left.category : '', typeof right.category === 'string' ? right.category : ''),
    );
};

export const buildImportReportEntries = (input: {
    readonly measurement: CatalogMeasurement;
    readonly shortfall: CatalogCoverageShortfall;
    readonly rows: readonly CoverageRow[];
    readonly requirement: RequirementBlock;
    readonly quarantine: QuarantineFigures;
    /** Per-item records the companion artefact carries, as this run counted
     * them while writing it. */
    readonly itemRecords: number;
    /** Published rows the aggregate pass counted, whatever their category —
     * the figure `itemRecords` was reconciled against. */
    readonly publishedRowsMeasured: number;
    readonly validationReportRelativePath: string;
    readonly scopedTo: string | null;
    readonly existing: Readonly<Record<string, unknown>> | null;
}): OwnedEntries => {
    const { measurement, shortfall, rows, requirement, quarantine, existing, scopedTo } = input;

    const failuresOverStatus = (byCheck: Readonly<Record<string, number>>): Record<string, unknown> => {
        // The four tiers are this module's own keys; the check names inside
        // each of them are the stored ones, so the inner maps are
        // prototype-free.
        const byTier: Record<string, Record<string, number>> = {
            reject: emptyCounts(),
            quarantine: emptyCounts(),
            review: emptyCounts(),
            unrecognised: emptyCounts(),
        };
        for (const [name, count] of Object.entries(byCheck)) {
            const tier = tierOfCheck(name) ?? 'unrecognised';
            byTier[tier][name] = count;
        }
        return {
            reject: sortedRecord(byTier.reject),
            quarantine: sortedRecord(byTier.quarantine),
            review: sortedRecord(byTier.review),
            unrecognised: sortedRecord(byTier.unrecognised),
        };
    };

    const publishedFailures = emptyCounts();
    for (const [name, tally] of Object.entries(measurement.publishedChecks)) {
        if (tally.failed > 0) {
            publishedFailures[name] = tally.failed;
        }
    }

    const entries: OwnedEntries = [
        ['reportVersion', REPORT_VERSION],
        ['producedBy', null],
        ['requirement', requirement],
        [
            'coverage',
            {
                publishedTargetTotal: shortfall.publishedTargetTotal,
                publishedTotal: shortfall.publishedTotal,
                shortfallTotal: shortfall.shortfallTotal,
                meetsPerCategoryTargets: shortfall.meetsTarget,
                // The same verdict as requirement.everyCategoryMeetsItsTarget,
                // read off the same rows: both artefacts state it, and
                // siblingReconciliation compares the figures behind it.
                everyCategoryMeetsItsTarget: rows.every((row) => !row.unmet),
                categoriesUnmet: rows.filter((row) => row.unmet).map(unmetCategoryEntry),
                shortfallComposition: requirement.shortfallComposition,
                categoriesBelowTarget: rows.filter((row) => row.unmet).length,
                categoriesMeasured: rows.length,
                unknownCategories: [...shortfall.unknownCategories].sort(compareStrings),
                measuredFrom: 'catalog_foods.publication_status grouped by category',
                scopedToCategory: scopedTo,
            },
        ],
        [
            'categoriesLegend',
            {
                publishedTarget: CATEGORIES_LEGEND.publishedTarget,
                candidateVolume: CATEGORIES_LEGEND.candidateVolume,
                published: CATEGORIES_LEGEND.published,
                quarantined: CATEGORIES_LEGEND.quarantined,
                shortfall: CATEGORIES_LEGEND.shortfall,
                candidate: CATEGORIES_LEGEND.candidate,
                rejected: CATEGORIES_LEGEND.rejected,
                retired: CATEGORIES_LEGEND.retired,
                otherFields:
                    'Any other field on a category row belongs to the import stage that measured it and is left ' +
                    'exactly as found; the per-check and per-food-state detail lives in the validation report.',
                order: 'ascending by category code',
            },
        ],
        ['categories', mergeCategoryRows(existing, rows)],
        [
            'coverageGaps',
            rows
                .filter((row) => row.shortfall > 0)
                .map((row) => ({
                    category: row.category,
                    publishedTarget: row.publishedTarget,
                    candidateVolume: row.candidateVolume,
                    published: row.published,
                    quarantined: row.quarantined,
                    candidate: row.candidate,
                    shortfall: row.shortfall,
                    unmet: row.unmet,
                })),
        ],
        [
            'countsByIdentitySource',
            { ...sortedRecord(measurement.publishedByIdentitySource), measuredFrom: 'catalog_foods.identity_source over published rows' },
        ],
        [
            'countsByNutritionProvenance',
            {
                ...sortedRecord(measurement.publishedByNutritionProvenance),
                measuredFrom: 'catalog_foods.nutrition_provenance over published rows',
                note:
                    'Recipe planning admits source_backed ingredients only, so any ingredient_derived or ai_estimated ' +
                    'food here is searchable and labelled as an estimate but never planned as an ingredient.',
            },
        ],
        [
            'countsByNutritionMethod',
            {
                byMethod: sortedRecord(measurement.publishedByNutritionMethod),
                measuredFrom: 'catalog_validation_records.nutrition_method over published rows',
                note: 'Keyed by the exact stored text, so the grouping is the validator\u2019s and not one inferred here.',
            },
        ],
        [
            'duplicatesRemoved',
            mergeSubObject(existing, 'duplicatesRemoved', {
                quarantinedForDuplicateIdentity: measurement.quarantinedByCheck.duplicate_identity ?? 0,
                publishedIdentityCollisions: measurement.publishedIdentityCollisions.length,
                aliasRecordsOnPublishedItems: measurement.publishedAliasRecords,
                measuredFrom:
                    'catalog_foods and catalog_validation_records: rows held by the duplicate_identity check, ' +
                    'published rows sharing a canonical name and food state, and the aliases published records carry.',
                note:
                    'The figures this stage can measure are the state the catalog is in now. Counts of what a run ' +
                    'skipped or merged while it was running are that run\u2019s own measurements and are preserved ' +
                    'here as the import stage wrote them; the two are different questions and neither is adjusted to ' +
                    'match the other.',
            }),
        ],
        [
            'failuresByCheck',
            mergeSubObject(existing, 'failuresByCheck', {
                checkNameVocabulary: CHECK_VOCABULARY_SOURCE,
                measuredFromCatalog: {
                    scope: 'the rows catalog_foods holds now, by publication status',
                    published: failuresOverStatus(publishedFailures),
                    quarantined: failuresOverStatus(measurement.quarantinedByCheck),
                    rejected: failuresOverStatus(measurement.rejectedByCheck),
                    note:
                        'A published row carrying a reject- or quarantine-tier failure would be a corrupt catalog; ' +
                        'review-tier flags on published rows are expected, because a review flag is recorded and the ' +
                        'record publishes.',
                },
            }),
        ],
        [
            'quarantined',
            mergeSubObject(existing, 'quarantined', {
                total: quarantine.total,
                byCheck: sortedRecord(measurement.quarantinedByCheck),
                perCategory: quarantine.perCategory,
                countsTowardPublishedTarget: false,
                identities: measurement.quarantinedIdentities,
                identityCap: WITHHELD_IDENTITY_LIMIT,
                identitiesOmittedByCap: measurement.withheldIdentitiesOmitted[QUARANTINED] ?? 0,
                measuredFrom:
                    'catalog_foods.publication_status = quarantined, joined to catalog_validation_records for the ' +
                    'failing checks. Both the per-category split and the identities exist only in those tables, which ' +
                    'is why a report derived from the committed release artefacts states them as unmeasured.',
                note:
                    'A quarantined record is never published on an invented value, so it counts toward no published ' +
                    'figure and toward no target. That is what keeps the shortfall truthful.',
            }),
        ],
        // The same audit both artefacts need, built from the same measurement:
        // quarantine is one of three statuses that mean a row is not published,
        // and a reader of this file's coverage gaps needs the other two as well.
        ['withheldIdentityAudit', buildWithheldIdentityAudit(rows, measurement)],
        [
            // The legal determination, the citations and the source-dataset
            // versions in this block are the import stage's and are preserved
            // byte for byte. Only the two generated-content assertions
            // SUPERSEDED_KEYS names are replaced, by the measurement below —
            // see WHETHER GENERATED CONTENT REACHED THE CATALOG, MEASURED.
            'dataProvenance',
            mergeSubObject(existing, 'dataProvenance', {
                generatedContent: generatedContentPresence(
                    measurement.publishedByIdentitySource,
                    measurement.withheldByIdentitySourceAndStatus,
                ),
                generationRefusalPolicy:
                    'Generation proposes generic preparations only and never a branded product: a candidate whose ' +
                    'name matches a brand pattern is refused at parse time, and a candidate whose identity evidence ' +
                    'does not retrieve is withheld rather than published. The rule stands whether or not a ' +
                    'generation run has happened, so it is stated separately from the measurement above.',
            }),
        ],
        [
            'environment',
            {
                databaseUrlEnvVar: DATABASE_URL_ENV,
                valuesRecorded: 'none \u2014 environment variable names only, never their values',
            },
        ],
        [
            'siblingReconciliation',
            mergeSubObject(existing, 'siblingReconciliation', {
                validationReport: {
                    path: input.validationReportRelativePath,
                    writtenByThisRun: true,
                    publishedItems: shortfall.publishedTotal,
                    publishedRowsMeasured: input.publishedRowsMeasured,
                    itemRecords: input.itemRecords,
                    itemRecordsAgreeWithPublishedRows: input.itemRecords === input.publishedRowsMeasured,
                    shortfallTotal: shortfall.shortfallTotal,
                    quarantineTotal: quarantine.total,
                    quarantinePerCategoryAgrees: true,
                    snapshotIsolation: REPORT_SNAPSHOT_ISOLATION,
                    agreementNote:
                        'Both artefacts were written from one REPEATABLE READ snapshot of catalog_foods \u2014 the ' +
                        'aggregate figures from one pass over it and the per-item records from a second \u2014 so the ' +
                        'two describe the same catalog state. Three things were checked before either file ' +
                        'replaced its predecessor: that the number of per-item records equals publishedRowsMeasured ' +
                        '(which is what proves the snapshot held for the whole run), that the quarantine figures ' +
                        'here match the block read back off the staged validation report, and that both documents ' +
                        'are complete. A disagreement ends the run with both previous artefacts intact instead of ' +
                        'producing two reports that cannot both be right.',
                    publishedItemsNote:
                        'publishedItems counts published rows in the categories the coverage plan declares, because ' +
                        'that is what the shortfall is measured from; publishedRowsMeasured counts every published ' +
                        'row whatever its category, because that is the scope the per-item records were written ' +
                        'over. They differ only when a published row sits in a category the plan does not declare, ' +
                        'which coverage.unknownCategories names.',
                },
            }),
        ],
        [
            'aggregateMeasurementGaps',
            [
                {
                    field: 'per-run counters (candidates attempted, batches planned or executed, USDA requests, model spend)',
                    value: null,
                    reason:
                        'Those are measurements of a run in progress, and this stage reads only the state the ' +
                        'catalog is in afterwards. They are preserved here exactly as the stage that measured them ' +
                        'wrote them, and this stage adds nothing to them.',
                },
                {
                    field: 'the cause of any per-category shortfall',
                    value: null,
                    reason:
                        'coverageGaps states the exact distance to each unmet target and no cause for it: the ' +
                        'counters that bear on one \u2014 plannedBatches, executedBatches, refusedCandidates, ' +
                        'aiGenerationCounts, usdaRequests \u2014 are the import and generation stages\u2019 own ' +
                        'measurements, preserved in this file by the stages that wrote them. This stage measures ' +
                        'the distance, not the reason.',
                },
                {
                    field: 'the full per-item check record for rejected rows',
                    value: null,
                    reason:
                        'A rejected row carries a validation record and is counted here by the check that ' +
                        'disqualified it, and it is named with that check in withheldIdentityAudit. Its complete ' +
                        'check record, with every observation and bound, is not restated: the per-item half of the ' +
                        'validation report covers published rows, which is what the catalog serves.',
                },
            ],
        ],
    ];

    return withProducedBy(entries, existing === null ? null : existing.producedBy, []);
};

// ---------------------------------------------------------------------------
// Serialization and IO.
//
// The validation report is tens of megabytes on a full catalog, so the item
// records are streamed one at a time and never assembled into a single object
// or a single string. Everything is seamed behind `ReportIo` so the write, the
// read-back and the merge can be driven without a file system.
// ---------------------------------------------------------------------------

export interface ReportSink {
    write(chunk: string): Promise<void>;
    end(): Promise<void>;
    /**
     * Abandons the sink without publishing anything. Safe to call after
     * `end()` and safe to call twice, so the failure path can release the
     * descriptor without having to know how far the writer got.
     */
    destroy(): void;
}

/** A sink onto the staging file for `finalPath`, and the staged artefact that
 * `promote` turns into the artefact at that path. */
export interface StagedSink {
    readonly sink: ReportSink;
    readonly staged: StagedArtifact;
}

export type OpenStagedSink = (absolutePath: string) => StagedSink;

/**
 * Every filesystem effect this stage has, behind one seam.
 *
 * Nothing here writes a canonical path: a document is STAGED and then
 * PROMOTED, which is what makes the reconciled pair appear together and makes
 * a failed run leave the previous pair untouched (see this file's header).
 * `src/__tests__/scripts/` drives `runReport` with a fake implementation, so
 * the staging, the reconciliation read and the promotion order are assertable
 * without a filesystem.
 */
export interface ReportIo {
    /** Opens a sink onto a staging file beside `absolutePath`. */
    readonly openStagedSink: OpenStagedSink;
    /**
     * The artefact's fields WITHOUT its `items` map, or `null` when the file
     * does not exist.
     *
     * Bounded on purpose: a full validation report is far too large to parse to
     * preserve a header out of, so the read stops at the `items` key and parses
     * the prefix. A file with no `items` key — the import report — is parsed
     * whole.
     *
     * Called for two different things: the CANONICAL path, to preserve the
     * fields another stage owns, and a STAGING path, to read back the document
     * this run just wrote so the two artefacts are reconciled against what
     * will actually land.
     */
    readonly readHeaderObject: (absolutePath: string) => Record<string, unknown> | null;
    /** Writes the complete document to a staging file for `absolutePath`. */
    readonly stageJsonObject: (absolutePath: string, value: Readonly<Record<string, unknown>>) => StagedArtifact;
    /** Renames a checked staged set over its canonical paths, back to back. */
    readonly promote: (staged: readonly StagedArtifact[]) => void;
    /** Removes staging files without touching any canonical path. */
    readonly discard: (staged: readonly StagedArtifact[]) => void;
    /**
     * Runs `publish` holding an exclusive publication lock on `directory`, so
     * no other stage can write into the report pair while this run reads one
     * half, merges it and promotes the result.
     */
    readonly withPublicationLock: <T>(directory: string, holder: string, publish: () => Promise<T>) => Promise<T>;
}

/**
 * The bound on the prefix read back to preserve another stage's fields.
 *
 * Sized against the LARGEST header this stage can write, not against the
 * smallest: the withheld-identity audit lists up to
 * {@link WITHHELD_IDENTITY_LIMIT} identities per status and the quarantine
 * block lists the quarantined ones again, so a catalog that withheld tens of
 * thousands of rows carries a header of a few megabytes rather than the few
 * tens of kilobytes it used to. A limit below that would make the read-back —
 * and therefore the reconciliation that gates the second artefact — fail on
 * exactly the catalog whose evidence matters most.
 *
 * Still a bound and not "whatever fits": a full validation report is tens of
 * megabytes of item records, so this stops a runaway read long before
 * available memory does.
 */
const HEADER_READ_LIMIT_BYTES = 32 * 1024 * 1024;

// `O_NOFOLLOW` is POSIX and present on every platform this pipeline runs on,
// but it is not in Node's constants on every platform, and `undefined` in a
// bitwise OR becomes 0 silently — which would quietly remove the protection.
// Read once, explicitly, so an absent constant is a documented degradation
// rather than an invisible one. Stated here rather than imported because
// manifest.ts keeps its copy private; the two are deliberately identical, and
// exporting one of them is the way to make that structural rather than
// conventional.
const O_NOFOLLOW_FLAG = typeof fs.constants.O_NOFOLLOW === 'number' ? fs.constants.O_NOFOLLOW : 0;

const openFileSink = (absolutePath: string): ReportSink => {
    fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
    // `wx`, not the default `w`: exclusive creation refuses an entry that
    // already exists, including a symlink someone else pre-placed at this
    // staging name, so the stream can never be pointed at a file outside the
    // output directory (CWE-59). `--out` accepts arbitrary directories, so this
    // matters on any shared one; manifest.ts opens its own staging files the
    // same way, and this was the one writer still using the permissive flag.
    const stream = fs.createWriteStream(absolutePath, { encoding: 'utf-8', flags: 'wx' });

    // A persistent listener, so a write failure between chunks is recorded
    // rather than raised as an unhandled 'error' event; `once` below turns a
    // failure during a drain wait into a rejection at the awaiting write.
    let failure: Error | null = null;
    stream.on('error', (error: Error) => {
        failure = error;
    });
    const throwIfFailed = (): void => {
        const recorded = failure;
        if (recorded !== null) {
            throw recorded;
        }
    };

    return {
        write: async (chunk: string): Promise<void> => {
            throwIfFailed();
            if (!stream.write(chunk)) {
                await once(stream, 'drain');
            }
            throwIfFailed();
        },
        end: async (): Promise<void> => {
            await new Promise<void>((resolve) => {
                stream.end(() => resolve());
            });
            throwIfFailed();
            // The staged document only becomes promotable here, so this is
            // where it has to be durable. `end()` flushes to the OS but not to
            // the disk: without this fsync a power loss after promotion could
            // leave the canonical path naming a file whose tail never landed —
            // and the completeness check reads that tail, so it would have
            // passed on data that no longer exists. The JSON staging path in
            // manifest.ts fsyncs for the same reason; the streamed path is
            // larger, which makes the window wider rather than narrower.
            const descriptor = fs.openSync(absolutePath, 'r+');
            try {
                fs.fsyncSync(descriptor);
            } finally {
                fs.closeSync(descriptor);
            }
        },
        // `destroy` is idempotent on a Node stream and does not throw after
        // `end`, and the persistent 'error' listener above absorbs the
        // ERR_STREAM_DESTROYED it may emit — so the failure path can always
        // call it without masking the error that caused the failure.
        destroy: (): void => {
            stream.destroy();
        },
    };
};

const parseHeaderText = (text: string, absolutePath: string): Record<string, unknown> => {
    let parsed: unknown;
    try {
        parsed = JSON.parse(text);
    } catch (error) {
        throw new CatalogReportError(
            `${absolutePath} is not readable as JSON, so the fields it already carries cannot be preserved ` +
                // The parser's own text is withheld: a JSON SyntaxError quotes
                // the bytes it choked on, and this file is an artefact whose
                // content is not this stage's to republish into a log
                // (logger.ts::safeError). The class and its machine code name
                // the fault; the remedy is what the operator acts on.
                `(${formatSafeError(error)}). Move or repair the file and run again.`,
            'report_unreadable',
        );
    }
    const record = asRecord(parsed);
    if (record === null) {
        throw new CatalogReportError(
            `${absolutePath} does not hold a JSON object, so it is not one of this pipeline's report artefacts.`,
            'report_unreadable',
        );
    }
    return record;
};

/**
 * The prefix of `absolutePath`, refusing a symlink and anything that is not a
 * regular file, or `null` when the file is not there.
 *
 * NO-FOLLOW, for the same reason manifest.ts's `readArtifactFileNoFollow` is:
 * this read is how the fields another stage owns are preserved and how the
 * document this run staged is reconciled against what will land, so a symlink
 * planted at either name would make both decisions from a document this
 * pipeline never wrote — and `existsSync` + `openSync(path, 'r')` follow one
 * without a word. That helper cannot be reused directly because it reads the
 * whole file and a validation report is tens of megabytes of item records; this
 * read is bounded by {@link HEADER_READ_LIMIT_BYTES} on purpose. The guarantee
 * is therefore rebuilt from the same three parts: `lstat` on the name, so the
 * entry is judged by what it IS rather than by what it resolves to; `O_NOFOLLOW`
 * on the open, so a link that appears in the window between the two is refused
 * by the kernel instead of read through; and `fstat` on the DESCRIPTOR actually
 * read from, which is the only check no path change can invalidate and which is
 * also where the size comes from.
 */
const readHeaderObjectFromFile = (absolutePath: string): Record<string, unknown> | null => {
    let entry: fs.Stats;
    try {
        entry = fs.lstatSync(absolutePath);
    } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'ENOENT' || code === 'ENOTDIR') {
            // Nothing at this name, so there are no existing fields to
            // preserve. That is the ordinary first run, not a failure.
            return null;
        }
        throw new CatalogReportError(
            `${absolutePath} could not be examined, so the fields it already carries cannot be preserved: ` +
                `${formatSafeError(error)}. Check the output directory and run again.`,
            'report_unreadable',
        );
    }

    if (!entry.isFile()) {
        throw new CatalogReportError(
            `${absolutePath} is ${entry.isSymbolicLink() ? 'a symbolic link' : 'not a regular file'}, so it is not ` +
                'one of this pipeline\u2019s report artefacts and nothing was read from it. Remove or rename what is ' +
                'at that name and run again.',
            'report_unreadable',
        );
    }

    let descriptor: number;
    try {
        descriptor = fs.openSync(absolutePath, fs.constants.O_RDONLY | O_NOFOLLOW_FLAG);
    } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'ENOENT' || code === 'ENOTDIR') {
            // Removed between the `lstat` and the open. Absent is absent.
            return null;
        }
        throw new CatalogReportError(
            code === 'ELOOP'
                ? `${absolutePath} became a symbolic link while this run was opening it, so nothing was read ` +
                  'through it. Remove or rename what is at that name and run again.'
                : `${absolutePath} could not be opened, so the fields it already carries cannot be preserved: ` +
                  `${formatSafeError(error)}. Check the output directory and run again.`,
            'report_unreadable',
        );
    }

    let size: number;
    let buffer: Buffer;
    try {
        // The descriptor, not a second `stat` on the path: this is the file the
        // bytes below come from, whatever the name now refers to.
        const opened = fs.fstatSync(descriptor);
        if (!opened.isFile()) {
            throw new CatalogReportError(
                `${absolutePath} is not a regular file, so it is not one of this pipeline\u2019s report artefacts ` +
                    'and nothing was read from it. Remove or rename what is at that name and run again.',
                'report_unreadable',
            );
        }

        size = opened.size;
        const readLength = Math.min(size, HEADER_READ_LIMIT_BYTES);
        buffer = Buffer.alloc(readLength);
        // A single `readSync` is not required to return everything asked for,
        // and a header that stops early would be parsed as a truncated
        // document. The loop is the read; a zero return means the file is
        // shorter than it reported (truncated while being read), which the
        // slice reports honestly rather than padding with zero bytes.
        let filled = 0;
        while (filled < readLength) {
            const read = fs.readSync(descriptor, buffer, filled, readLength - filled, filled);
            if (read === 0) {
                break;
            }
            filled += read;
        }
        if (filled < readLength) {
            buffer = buffer.subarray(0, filled);
        }
    } finally {
        fs.closeSync(descriptor);
    }

    // The key is searched for in the BYTES, not in a decoded prefix: decoding a
    // chunk that ends mid-character would corrupt the prose it preserves.
    const marker = `\n  ${JSON.stringify(ITEMS_KEY)}:`;
    const index = buffer.indexOf(marker, 0, 'utf8');
    if (index >= 0) {
        const head = buffer.subarray(0, index).toString('utf-8').replace(/,\s*$/, '');
        return parseHeaderText(`${head}\n}`, absolutePath);
    }

    if (size <= HEADER_READ_LIMIT_BYTES) {
        return parseHeaderText(buffer.toString('utf-8'), absolutePath);
    }

    throw new CatalogReportError(
        `${absolutePath} is larger than ${formatCount(HEADER_READ_LIMIT_BYTES)} bytes and carries no "${ITEMS_KEY}" ` +
            'key in its first block, so its existing fields cannot be preserved without parsing all of it. Move or ' +
            'repair the file and run again.',
        'report_unreadable',
    );
};

/**
 * The real filesystem, through `scripts/lib/manifest.ts`.
 *
 * Every write goes to a staging file and every publication is a rename, so the
 * atomicity is the pipeline's one implementation rather than this stage's own
 * (`stagingPathFor`, `stageJsonArtifact`, `promoteStagedArtifacts`,
 * `discardStagedArtifacts` and `withArtifactPublicationLock` are shared with
 * `catalog-import-usda.ts`, `catalog-generate-ai.ts` and `catalog-validate.ts`,
 * which write into the same two files).
 */
export const defaultReportIo = (): ReportIo => ({
    openStagedSink: (absolutePath): StagedSink => {
        const staged: StagedArtifact = { finalPath: absolutePath, stagingPath: stagingPathFor(absolutePath) };
        return { sink: openFileSink(staged.stagingPath), staged };
    },
    readHeaderObject: readHeaderObjectFromFile,
    stageJsonObject: (absolutePath, value): StagedArtifact => stageJsonArtifact(absolutePath, value),
    promote: promoteStagedArtifacts,
    discard: discardStagedArtifacts,
    withPublicationLock: withArtifactPublicationLock,
});

/** Re-indents a pretty-printed value so it can be nested inside a document
 * this module assembles by hand. */
const indentJson = (value: unknown, spaces: number): string => {
    const text = JSON.stringify(value, null, 2);
    return spaces === 0 ? text : text.split('\n').join(`\n${' '.repeat(spaces)}`);
};

/**
 * The merge: existing keys keep their value only where this stage does not own
 * them, and keep their POSITION either way, so a rerun produces a minimal diff
 * and a field another stage measured is never lost.
 */
export const mergeOwnedFields = (
    existing: Readonly<Record<string, unknown>> | null,
    entries: readonly (readonly [string, unknown])[],
): Record<string, unknown> => {
    // The existing document is copied key by key into a prototype-free target
    // rather than spread into a plain one, so a `__proto__` key already in the
    // artefact stays the ordinary property `JSON.parse` read it as instead of
    // becoming this object's prototype — which is how a preserved field
    // disappears from a document that promises to preserve it.
    const merged = existing === null ? emptyIndex<unknown>() : copyOwnEntries(existing);
    for (const [key, value] of entries) {
        merged[key] = value;
    }
    return merged;
};

export type EmitItem = (key: string, item: unknown) => Promise<void>;

export const writeValidationReport = async (input: {
    readonly sink: ReportSink;
    readonly existing: Readonly<Record<string, unknown>> | null;
    readonly entries: OwnedEntries;
    readonly emitItems: (emit: EmitItem) => Promise<void>;
}): Promise<{ readonly itemCount: number }> => {
    const header = mergeOwnedFields(
        input.existing,
        input.entries.filter(([key]) => key !== ITEMS_KEY),
    );

    // `items` is appended rather than serialized with the header, so the whole
    // document never exists in memory at once. Slicing the closing "\n}" off a
    // pretty-printed object is what keeps the output identical in shape to a
    // single JSON.stringify(..., null, 2).
    const headerText = JSON.stringify(header, null, 2);
    const prefix = headerText.slice(0, Math.max(0, headerText.length - 2));

    await input.sink.write(`${prefix},\n  ${JSON.stringify(ITEMS_KEY)}: {`);

    let itemCount = 0;
    await input.emitItems(async (key, item) => {
        await input.sink.write(`${itemCount === 0 ? '\n' : ',\n'}    ${JSON.stringify(key)}: ${indentJson(item, 4)}`);
        itemCount += 1;
    });

    await input.sink.write(itemCount === 0 ? '}\n}\n' : '\n  }\n}\n');
    await input.sink.end();

    return { itemCount };
};

// ---------------------------------------------------------------------------
// Reconciliation.
// ---------------------------------------------------------------------------

const numericRecord = (value: unknown): Record<string, number> => {
    const record = asRecord(value);
    const numbers = emptyCounts();
    if (record === null) {
        return numbers;
    }
    for (const key of Object.keys(record)) {
        const entry = record[key];
        if (typeof entry === 'number') {
            numbers[key] = entry;
        }
    }
    return numbers;
};

/** The quarantine figures as the artefact on disk states them. */
export const quarantineFiguresOf = (
    header: Readonly<Record<string, unknown>> | null,
    absolutePath: string,
): QuarantineFigures => {
    const block = header === null ? null : asRecord(header.quarantine);
    if (block === null || typeof block.total !== 'number') {
        throw new CatalogReportError(
            `${absolutePath} carries no readable quarantine block, so the two artefacts cannot be reconciled. ` +
                'The run stops rather than writing a second report that nothing has checked.',
            'report_unreadable',
        );
    }
    return { total: block.total, perCategory: numericRecord(block.perCategory) };
};

/**
 * The two artefacts must state the same quarantine figures.
 *
 * A quarantined row is excluded from every published count, so a disagreement
 * between the two files means one of them is misstating the distance between
 * the catalog and the plan — and a shortfall is the one number in this pipeline
 * that is never negotiable. Both numbers are named, because the point of the
 * failure is to show which artefact to distrust, and neither is silently
 * adjusted to match the other.
 */
export const reconcileQuarantineFigures = (input: {
    readonly validationReportPath: string;
    readonly importReportPath: string;
    readonly onDisk: QuarantineFigures;
    readonly measured: QuarantineFigures;
}): void => {
    const disagreements: string[] = [];

    if (input.onDisk.total !== input.measured.total) {
        disagreements.push(
            `total: ${formatCount(input.onDisk.total)} in ${VALIDATION_REPORT_FILE} against ` +
                `${formatCount(input.measured.total)} bound for ${IMPORT_REPORT_FILE}`,
        );
    }

    const categories = [...new Set([...Object.keys(input.onDisk.perCategory), ...Object.keys(input.measured.perCategory)])].sort(
        compareStrings,
    );
    for (const category of categories) {
        // `ownValue`, not `[]`: `undefined` here MEANS "this artefact does not
        // state a figure for that category", and an inherited value would be
        // read as one — reconciling two documents against a property of
        // `Object.prototype`.
        const onDisk = ownValue(input.onDisk.perCategory, category);
        const measured = ownValue(input.measured.perCategory, category);
        if (onDisk === measured) {
            continue;
        }
        disagreements.push(
            `${category}: ${onDisk === undefined ? 'absent' : formatCount(onDisk)} in ${VALIDATION_REPORT_FILE} ` +
                `against ${measured === undefined ? 'absent' : formatCount(measured)} bound for ${IMPORT_REPORT_FILE}`,
        );
    }

    if (disagreements.length === 0) {
        return;
    }

    throw new CatalogReportError(
        `the quarantine figures in ${input.validationReportPath} disagree with the figures bound for ` +
            `${input.importReportPath}, so one of the two artefacts is wrong and neither was published: ` +
            `${disagreements.join('; ')}.`,
        'quarantine_reconciliation_failed',
    );
};

/** How many per-item records the emitting pass produced, against what the
 * aggregate pass counted, and what the emitter had to skip. */
export interface ItemCountReconciliation {
    /** Records written into the validation report's `items` map. */
    readonly itemsEmitted: number;
    /** `publication_status = published` rows the aggregate pass counted. */
    readonly publishedRowsMeasured: number;
    /** Published rows the emitting pass found with no validation record. */
    readonly skippedWithoutRecord: number;
    /** The first few of those rows, named so an operator can act. */
    readonly skippedNamed: readonly string[];
}

/** How many skipped identities the failure names before summarising. */
const SKIPPED_NAMED_LIMIT = 20;

/**
 * The two passes must have seen one catalog.
 *
 * The aggregate pass counts published rows; the emitting pass writes one record
 * per published row. Those numbers are the same number measured twice, and the
 * whole point of reading both through one snapshot is that they cannot drift —
 * so a difference is not a discrepancy to report in the artefact, it is
 * evidence that the run is not describing a single state, and the run ends
 * before either file is published.
 *
 * A published row the emitter had to skip fails the run even when the totals
 * happen to agree: `assertEveryPublishedItemHasARecord` already proved on the
 * aggregate pass that every published row carries a record, so a skip means the
 * row lost it mid-run — and two offsetting changes can leave the totals equal
 * while the evidence is short by one item.
 */
export const reconcileItemCount = (input: {
    readonly validationReportPath: string;
    readonly reconciliation: ItemCountReconciliation;
}): void => {
    const { itemsEmitted, publishedRowsMeasured, skippedWithoutRecord, skippedNamed } = input.reconciliation;

    if (itemsEmitted === publishedRowsMeasured && skippedWithoutRecord === 0) {
        return;
    }

    const problems: string[] = [];
    if (itemsEmitted !== publishedRowsMeasured) {
        problems.push(
            `${formatCount(itemsEmitted)} per-item record(s) were written for ` +
                `${formatCount(publishedRowsMeasured)} published row(s) the aggregate pass counted`,
        );
    }
    if (skippedWithoutRecord > 0) {
        const named = skippedNamed.slice(0, SKIPPED_NAMED_LIMIT).join(', ');
        const remainder =
            skippedWithoutRecord > skippedNamed.length
                ? ` and ${formatCount(skippedWithoutRecord - skippedNamed.length)} more`
                : '';
        problems.push(
            `${formatCount(skippedWithoutRecord)} published row(s) carried no catalog_validation_records row when ` +
                `the records were written, although the aggregate pass found one for every published row: ` +
                `${named}${remainder}`,
        );
    }

    throw new CatalogReportError(
        `the two passes over catalog_foods did not describe the same catalog, so neither artefact was published and ` +
            `the previous ${VALIDATION_REPORT_FILE} and ${IMPORT_REPORT_FILE} are intact: ${problems.join('; ')}. ` +
            'Both passes read through one REPEATABLE READ snapshot, so this means the snapshot was not held for the ' +
            'whole run — re-run the report with no other catalog stage running.',
        'item_count_mismatch',
    );
};

// ---------------------------------------------------------------------------
// The run.
// ---------------------------------------------------------------------------

export interface RunReportDeps {
    readonly db: ReportDb;
    readonly plan: CoveragePlan;
    readonly allowlistVersion: string;
    readonly evidenceRegistrySnapshot: string;
    readonly options: ReportOptions;
    /**
     * The directory to publish the pair into. `main()` passes the physical
     * identity `resolveReportOutputDirectory` decided, and `runReport` resolves
     * whatever it is given to that identity again — so a caller may hand over a
     * spelling and still get one directory for the lock and both writes, and
     * the paths in {@link ReportOutcome} name the place the artefacts are in.
     */
    readonly outDir: string;
    readonly logger: ScriptLogger;
    readonly io: ReportIo;
}

export interface ReportOutcome {
    readonly validationReportPath: string;
    readonly importReportPath: string;
    readonly rowsScanned: number;
    /**
     * Published rows in the categories the coverage plan declares — the total
     * the shortfall is measured from. A published row in a category the plan
     * does not declare is excluded here and named in `coverage.unknownCategories`.
     */
    readonly publishedItems: number;
    /**
     * Every `publication_status = published` row the aggregate pass counted,
     * whatever its category. This is the figure the per-item record count is
     * reconciled against, because the emitting pass is scoped by publication
     * status and not by the plan.
     */
    readonly publishedRows: number;
    readonly itemRecords: number;
    readonly quarantined: number;
    readonly shortfallTotal: number;
    readonly requirementMet: boolean;
    readonly unmetRequirements: readonly string[];
}

/**
 * The key under which this stage records what its write into
 * `import-report.json` preserved. Each stage writing that file has its own
 * (`importStageWrite`, `generationStageWrite`), so the three notes sit beside
 * each other rather than overwriting one another.
 */
export const REPORT_STAGE_NOTE_KEY = 'reportStageWrite';

/** The lock holder name this stage takes on the output directory. */
const PUBLICATION_HOLDER = `${STAGE}:artefacts`;

/**
 * Refuses a scoped run whose destination is the committed report directory or
 * something inside it, for the physical identity `publicationDirectory`.
 *
 * Called TWICE by `runReport`: once before the publication lock is taken, so a
 * refused run creates nothing — acquiring the lock creates the output
 * directory, and a refusal that had already made a directory inside the
 * committed tree would leave litter there — and once inside the lock on the
 * re-verified identity, so a retarget after the first check cannot land one
 * category's figures on the whole-catalog pair. Neither call is redundant: the
 * first decides early, the second decides late, and the attack lives in the
 * gap between them.
 */
const assertScopedReportMayPublish = (
    scopedTo: string,
    out: string | null,
    publicationDirectory: string,
): void => {
    const refusal = scopedReportRefusal({
        category: scopedTo,
        out,
        resolvedOutDir: publicationDirectory,
        canonicalReportDir: physicalPathIdentity(canonicalReportDirectory()),
    });
    if (refusal !== null) {
        throw new CatalogReportError(refusal, 'scoped_report_needs_out_dir');
    }
};

export const runReport = async (deps: RunReportDeps): Promise<ReportOutcome> => {
    const { db, plan, options, outDir, logger: runLogger, io } = deps;
    const scopedTo = options.category;

    // The policy the shortfall is measured against. Under `--category` it holds
    // that category alone, so every total the artefacts state is scoped the
    // same way the rows are and no absent category is reported as a shortfall.
    const policy: CatalogValidationPolicy = {
        categories: scopedTo === null ? plan.categories : plan.categories.filter((entry) => entry.category === scopedTo),
        validationBounds: plan.validationBounds,
    };

    const where: Record<string, unknown> = scopedTo === null ? {} : { category: scopedTo };

    // THE destination, resolved once. Both artefact paths and the publication
    // lock are built from this one value, so the directory that is locked is
    // the directory that is written — and because an identity carries no
    // symlink, a retarget of the path `outDir` was spelled as cannot redirect
    // either of them (see the section above `publicationDirectoryDriftRefusal`).
    // `main()` already hands over an identity; a caller that hands over a
    // spelling gets the same guarantee from this line.
    const publicationDirectory = physicalPathIdentity(outDir);

    // Before the lock, because taking the lock creates the output directory:
    // a scoped run aimed at the committed pair must be refused without leaving
    // a directory behind inside the committed tree. The same check runs again
    // under the lock, on the identity verified there.
    if (scopedTo !== null) {
        assertScopedReportMayPublish(scopedTo, options.out, publicationDirectory);
    }

    const validationReportPath = path.join(publicationDirectory, VALIDATION_REPORT_FILE);
    const importReportPath = path.join(publicationDirectory, IMPORT_REPORT_FILE);

    // The lock spans the WHOLE run, not just the two renames. The half of
    // `import-report.json` this stage does not own is read at the end and
    // merged into what it writes; an import or generation run publishing into
    // that file between the read and the promotion would have its counters
    // silently reverted to the values this run read. Holding the lock across
    // both passes also means the artefacts an operator finds afterwards were
    // produced by exactly one publisher.
    return io.withPublicationLock(publicationDirectory, PUBLICATION_HOLDER, async (): Promise<ReportOutcome> => {
        // UNDER THE LOCK, BEFORE ANYTHING IS READ OR STAGED. Resolving the
        // destination and publishing into it are two moments, and everything an
        // attacker needs is the gap between them: retarget a symlink on the
        // output path, or replace the resolved directory, and a run that trusted
        // its earlier answer would publish somewhere it never checked. The lock
        // is keyed on this same identity (manifest.ts's
        // `ArtifactPublicationLock.physicalDirectory`), so re-deriving it here
        // also proves the lock and the writes are about one directory.
        const drift = publicationDirectoryDriftRefusal({
            named: outDir,
            expected: publicationDirectory,
            observedFromNamedPath: physicalPathIdentity(outDir),
            observedFromIdentity: physicalPathIdentity(publicationDirectory),
        });
        if (drift !== null) {
            throw new CatalogReportError(drift, 'output_directory_changed');
        }

        // And the scoped-report guard again, on the identity just verified.
        // `main()` checks it before the run starts and this function checks it
        // before the lock, which is where an operator wants the refusal;
        // repeating it here is what stops a retarget after those checks — or a
        // caller that never made them — from landing one category's figures on
        // the committed whole-catalog pair.
        if (scopedTo !== null) {
            assertScopedReportMayPublish(scopedTo, options.out, publicationDirectory);
        }

        // THE DIRECTORY BOTH ARTEFACT NAMES ARE CREATED IN, held to the
        // pipeline's one definition of a publishable parent: a real directory,
        // not a link, that no other local principal may plant a name in. Both
        // artefacts share it, so one call decides for both. `main()` holds the
        // publication directory's OWN parent to the same rule when it decides
        // the destination (`resolveReportOutputDirectory`); this call is the one
        // every caller of `runReport` goes through, and it runs before anything
        // is read, staged or promoted.
        assertSafeArtifactParent(validationReportPath);

        // THE IDENTITY OF THE DIRECTORY ITSELF, captured now — under the lock,
        // on a directory whose resolution has just been re-verified — and
        // re-checked immediately before every path-based operation that follows
        // the awaited measurement below.
        //
        // Node offers no descriptor-relative open here: there is no `openat`,
        // no `mkdirat` and no `renameat`, and neither `fs.rename` nor
        // `fs.createWriteStream` will take a directory handle. This stage
        // therefore cannot hold the publication directory as a capability and
        // write through it — the instrument available is revalidation
        // immediately before each path use, which narrows the window to the two
        // statements between the `lstat` and the call it authorises and turns a
        // redirected publication into a refusal instead of a silent write
        // somewhere else (CWE-59, CWE-367).
        const publicationIdentity = observePublicationDirectory(publicationDirectory, runLogger);
        if (publicationIdentity === null) {
            throw new CatalogReportError(
                `${publicationDirectory} does not hold a real directory under the publication lock, so this run has ` +
                    `no identity to hold its writes to and published nothing; the previous ${VALIDATION_REPORT_FILE} ` +
                    `and ${IMPORT_REPORT_FILE} are intact. Check what is at that name, then run the stage again.`,
                'output_directory_changed',
            );
        }

        /**
         * Refuses unless the publication directory is still the one identified
         * above. Called immediately before each path-based operation after the
         * measurement, so nothing separates the check from the act it
         * authorises, and `operation` names what did not happen.
         */
        const assertPublicationDirectoryUnreplaced = (operation: string): void => {
            const replaced = publicationDirectoryReplacedRefusal({
                directory: publicationDirectory,
                operation,
                expected: publicationIdentity,
                observed: observePublicationDirectory(publicationDirectory, runLogger),
            });
            if (replaced !== null) {
                throw new CatalogReportError(replaced, 'output_directory_changed');
            }
        };

        const measurement = await measureCatalog(db, where);
        runLogger.info('catalog_measured', {
            stage: STAGE,
            rowsScanned: measurement.rowsScanned,
            byPublicationStatus: JSON.stringify(sortedRecord(measurement.byPublicationStatus)),
            categoryFilter: scopedTo,
        });

        // Before either artefact is written: a published food with no validation
        // record would make this report claim evidence that does not exist.
        assertEveryPublishedItemHasARecord(measurement);

        // The offending rows are logged as structured fields as well as named
        // in the failure, because `describeFailure` reports a code and a
        // scrubbed error and deliberately no message — so without this line the
        // operator would see that the run refused and not which rows to fix.
        if (measurement.unrecognisedStoredValueCount > 0) {
            runLogger.error('stored_value_outside_closed_set', {
                stage: STAGE,
                values: measurement.unrecognisedStoredValueCount,
                columns: [...new Set(measurement.unrecognisedStoredValues.map((entry) => entry.field))]
                    .sort(compareStrings)
                    .join(','),
                examples: measurement.unrecognisedStoredValues
                    .map((entry) => `${entry.sourceKey} ${entry.field}=${entry.value}`)
                    .join('; '),
            });
        }
        assertRecognisedStoredValues(measurement);

        const shortfall = computeCoverageShortfall(policy, measurement.publishedByCategory);
        const rows = buildCoverageRows(policy, plan, measurement, shortfall);
        const requirement = buildRequirementBlock({ plan, measurement, shortfall, rows, scopedTo });
        const quarantine: QuarantineFigures = {
            total: statusCount(measurement.byPublicationStatus, QUARANTINED),
            perCategory: quarantinePerCategory(rows, measurement),
        };
        const publishedRows = statusCount(measurement.byPublicationStatus, PUBLISHED);

        // The CANONICAL file, so the fields the import and generation stages own
        // are the ones preserved; the staged document read back below is this
        // run's own output.
        //
        // The measurement above was awaited, which means the filesystem has had
        // the length of two catalog scans to change since the checks under the
        // lock. Every path use from here to the promotion therefore re-verifies
        // the directory first.
        assertPublicationDirectoryUnreplaced(`reading the fields ${VALIDATION_REPORT_FILE} already carries`);
        const existingValidationReport = io.readHeaderObject(validationReportPath);
        const validationEntries = buildValidationReportEntries({
            plan,
            policy,
            allowlistVersion: deps.allowlistVersion,
            evidenceRegistrySnapshot: deps.evidenceRegistrySnapshot,
            measurement,
            shortfall,
            rows,
            requirement,
            scopedTo,
            existing: existingValidationReport,
        });

        assertPublicationDirectoryUnreplaced(`staging ${VALIDATION_REPORT_FILE}`);
        const validationSink = io.openStagedSink(validationReportPath);
        const staged: StagedArtifact[] = [validationSink.staged];

        try {
            let skippedWithoutRecord = 0;
            const skippedNamed: string[] = [];

            const { itemCount } = await writeValidationReport({
                sink: validationSink.sink,
                existing: existingValidationReport,
                entries: validationEntries,
                emitItems: async (emit) => {
                    await forEachFoodPage(db, { ...where, publication_status: PUBLISHED }, async (page) => {
                        for (const row of page) {
                            const record = row.catalog_validation_records;
                            if (record === null) {
                                // Counted and named rather than passed over: the
                                // aggregate pass already proved every published row
                                // has a record, so this can only mean the two passes
                                // disagree, which `reconcileItemCount` turns into a
                                // failed run below.
                                skippedWithoutRecord += 1;
                                if (skippedNamed.length < SKIPPED_NAMED_LIMIT) {
                                    skippedNamed.push(row.source_key);
                                }
                                continue;
                            }
                            await emit(row.source_key, toItemRecord(row, record));
                        }
                    });
                },
            });
            runLogger.info('validation_report_staged', {
                stage: STAGE,
                path: validationReportPath,
                stagingPath: validationSink.staged.stagingPath,
                itemRecords: itemCount,
                publishedRowsMeasured: publishedRows,
                skippedWithoutRecord,
            });

            // The proof that the snapshot held: one number measured twice.
            reconcileItemCount({
                validationReportPath,
                reconciliation: {
                    itemsEmitted: itemCount,
                    publishedRowsMeasured: publishedRows,
                    skippedWithoutRecord,
                    skippedNamed,
                },
            });

            // Read back from the STAGED document, not from the object just
            // built: what the next stage and the next reviewer will read is the
            // file, and only the file can show that what this run measured is
            // what it actually serialised. Reading the canonical path here
            // instead would reconcile against the PREVIOUS run's artefact.
            //
            // The item pass above is the second awaited scan, so the directory
            // is re-verified before this read too: the staging path is a name
            // inside it, and a reconciliation made from a document read through
            // a replaced directory would gate the pair on somebody else's file.
            assertPublicationDirectoryUnreplaced(`reading the staged ${VALIDATION_REPORT_FILE} back`);
            reconcileQuarantineFigures({
                validationReportPath,
                importReportPath,
                onDisk: quarantineFiguresOf(
                    io.readHeaderObject(validationSink.staged.stagingPath),
                    validationSink.staged.stagingPath,
                ),
                measured: quarantine,
            });

            assertPublicationDirectoryUnreplaced(`reading the fields ${IMPORT_REPORT_FILE} already carries`);
            const existingImportReport = io.readHeaderObject(importReportPath);
            // One merge policy for all three stages that write this file
            // (`MERGED_REPORT_COMPOUND_BLOCKS`), so a sub-key a sibling stage
            // contributes to a shared block cannot be dropped by a top-level
            // replacement here — the same helper `catalog-import-usda.ts` and
            // `catalog-generate-ai.ts` write through.
            const merge = mergeStageReport(
                existingImportReport,
                Object.fromEntries(
                    buildImportReportEntries({
                        measurement,
                        shortfall,
                        rows,
                        requirement,
                        quarantine,
                        itemRecords: itemCount,
                        publishedRowsMeasured: publishedRows,
                        validationReportRelativePath: `data/meal-planning/reports/latest/${VALIDATION_REPORT_FILE}`,
                        scopedTo,
                        existing: existingImportReport,
                    }),
                ),
                {
                    noteKey: REPORT_STAGE_NOTE_KEY,
                    stage: STAGE,
                    compoundBlocks: MERGED_REPORT_COMPOUND_BLOCKS,
                },
            );

            assertPublicationDirectoryUnreplaced(`staging ${IMPORT_REPORT_FILE}`);
            staged.push(io.stageJsonObject(importReportPath, merge.document));
            runLogger.info('import_report_staged', {
                stage: STAGE,
                path: importReportPath,
                preservedKeys: merge.preservedKeys.join(','),
                preservedSubKeys: JSON.stringify(merge.preservedSubKeys),
                // Normally empty on this stage's own write: it supplies the
                // aggregate assertions it owns, so they are replaced rather
                // than dropped. A name here means this run did not write one
                // it found — a scoped run, say — and the claim was removed
                // instead of left standing over data it no longer describes.
                droppedAggregateAssertions: merge.droppedAggregateAssertions.join(','),
            });

            // The publication: both documents are complete, both are reconciled
            // against each other, and only now does either replace what is on
            // disk.
            //
            // The last revalidation, immediately before the renames. Promotion
            // is the one operation whose effect cannot be taken back, and it is
            // performed on the artefact PATHNAMES — so this is the check that
            // decides whether the pair lands in the directory this run locked or
            // in whatever took its place.
            assertPublicationDirectoryUnreplaced(`publishing ${VALIDATION_REPORT_FILE} and ${IMPORT_REPORT_FILE}`);
            io.promote(staged);
            runLogger.info('artefacts_published', {
                stage: STAGE,
                validationReport: validationReportPath,
                importReport: importReportPath,
                itemRecords: itemCount,
            });

            return {
                validationReportPath,
                importReportPath,
                rowsScanned: measurement.rowsScanned,
                publishedItems: shortfall.publishedTotal,
                publishedRows,
                itemRecords: itemCount,
                quarantined: quarantine.total,
                shortfallTotal: shortfall.shortfallTotal,
                requirementMet: requirement.requirementMet,
                unmetRequirements: requirement.unmetRequirements.map((entry) => entry.code),
            };
        } catch (error) {
            // A failure before `promote` has touched nothing canonical, and a
            // failure inside `promote` has already rolled the set back to the
            // generation it found (manifest.ts publishes through a journal, so
            // the canonical paths are all-new or all-previous once it returns).
            // Either way the recovery here is the same: drop the staging files
            // and re-raise. The sink is destroyed first in case the failure
            // happened mid-stream. A failed report is a run that produced no
            // evidence, never a run that half-replaced the evidence it was
            // rewriting — but note that is a property of the journal, not of
            // this handler, which cannot undo a rename by itself.
            //
            // The discard is by pathname and deliberately NOT gated on the
            // directory identity: it must run even when the refusal above was
            // the directory being replaced, or this run's own staging files
            // would be left behind, and it cannot remove anything of anyone
            // else's because every staging name carries manifest.ts's
            // unguessable suffix and "already gone" is treated as success.
            validationSink.sink.destroy();
            io.discard(staged);
            runLogger.warn('artefacts_discarded', {
                stage: STAGE,
                stagingPaths: staged.map((artifact) => artifact.stagingPath).join(','),
                validationReport: validationReportPath,
                importReport: importReportPath,
                // This field says what is KNOWN here, which is not the state of
                // the canonical pair. `promoteStagedArtifacts` proves its
                // rollback before it reports one, and a rollback step that
                // fails leaves the journal and the backups on disk and says so
                // in the message logged verbatim under `error` below — so a
                // fixed claim here that the previous generation is back would
                // contradict that message in exactly the case an operator is
                // reading this line to understand.
                previousArtefacts:
                    'stated in error: a rollback is reported only once proven, and otherwise the publication ' +
                    'journal and the backups were kept for the next run to revert from',
                error: safeError(error),
            });
            throw error;
        }
    });
};

// ---------------------------------------------------------------------------
// Reporting.
// ---------------------------------------------------------------------------

// Every error class this file can observe gets its own reported code; anything
// unrecognised is reported through safeError under `unexpected_error` rather
// than swallowed or printed raw (Rule backend-architecture §8).
// The reported `error` is `SafeErrorFields` — a scrubbed name plus an optional
// machine code and status, and deliberately no `message`: this value reaches the
// durable run log and the operator console, where foreign prose can carry a
// connection URL, a key or a fragment of the document that failed (CWE-532).
const describeFailure = (error: unknown): { code: string; error: SafeErrorFields } => {
    if (isThrownInstanceOf(error, CatalogReportError)) {
        return { code: error.code, error: safeError(error) };
    }
    if (isThrownInstanceOf(error, DatabaseOriginError)) {
        return { code: error.code, error: safeError(error) };
    }
    if (isThrownInstanceOf(error, ManifestError)) {
        return { code: error.code, error: safeError(error) };
    }
    return { code: 'unexpected_error', error: safeError(error) };
};

const requirementFields = (outcome: ReportOutcome): LogFields => ({
    stage: STAGE,
    publishedItems: outcome.publishedItems,
    requiredPublishedItems: REQUIRED_PUBLISHED_ITEMS,
    shortfallAgainstRequirement: Math.max(0, REQUIRED_PUBLISHED_ITEMS - outcome.publishedItems),
    perCategoryShortfallTotal: outcome.shortfallTotal,
    unmetRequirements: outcome.unmetRequirements.join(','),
    reportedIn: outcome.validationReportPath,
});

/**
 * The client capability this stage needs beyond {@link ReportDb}: an
 * interactive transaction to pin a snapshot in.
 *
 * Declared structurally and reached through one cast at the call site, for the
 * same reason `ReportDb` is — it is the narrowest surface this stage can be
 * handed, so the snapshot cannot quietly become a place where writes happen.
 */
interface SnapshotCapableClient {
    $transaction: <T>(
        run: (tx: unknown) => Promise<T>,
        options: {
            readonly isolationLevel: typeof REPORT_SNAPSHOT_ISOLATION;
            readonly timeout: number;
            readonly maxWait: number;
        },
    ) => Promise<T>;
}

/** Whether an error is one Prisma raised — every Prisma error code is `P` and
 * digits, and none of this stage's own errors carry a `code` of that shape. */
const isPrismaError = (error: unknown): boolean => {
    const code = (error as { code?: unknown } | null)?.code;
    return typeof code === 'string' && /^P\d/.test(code);
};

/**
 * Runs `run` against a pinned snapshot of the catalog.
 *
 * Both of this stage's passes read through the client it hands over, so they
 * see one catalog state however long the run takes and whatever else is
 * writing to the database (see this file's header).
 */
const openReportSnapshot = async <T>(client: SnapshotCapableClient, run: (db: ReportDb) => Promise<T>): Promise<T> => {
    try {
        return await client.$transaction((tx) => run(tx as ReportDb), {
            isolationLevel: REPORT_SNAPSHOT_ISOLATION,
            timeout: REPORT_SNAPSHOT_TIMEOUT_MS,
            maxWait: REPORT_SNAPSHOT_MAX_WAIT_MS,
        });
    } catch (error) {
        // A failure raised INSIDE the snapshot keeps its own code: it is a
        // finding about the catalog or about the artefacts, not about the
        // snapshot, and relabelling it would send an operator to the wrong
        // place.
        if (isThrownInstanceOf(error, CatalogReportError) || isThrownInstanceOf(error, ManifestError) || isThrownInstanceOf(error, DatabaseOriginError)) {
            throw error;
        }
        if (isPrismaError(error)) {
            throw new CatalogReportError(
                'the snapshot the two passes share could not be opened or could not be held for the whole run, so ' +
                    'no artefact was written and the previous pair is intact: ' +
                    // Prisma's message carries the connection target and the
                    // failing statement's values; its `P####` code is the part
                    // an operator searches for, and formatSafeError keeps
                    // exactly that.
                    `${formatSafeError(error)} (isolation ${REPORT_SNAPSHOT_ISOLATION}, timeout ` +
                    `${REPORT_SNAPSHOT_TIMEOUT_MS} ms, connection wait ${REPORT_SNAPSHOT_MAX_WAIT_MS} ms).`,
                'report_snapshot_failed',
            );
        }
        // Anything else is re-raised as itself and reported under
        // `unexpected_error`, never relabelled as a snapshot problem.
        throw error;
    }
};

/**
 * Exit codes say whether EVIDENCE WAS PRODUCED, not whether the evidence is
 * good news: 0 means both artefacts were published and reconciled, 1 means
 * they were not. An unmet requirement is a successfully measured finding — it
 * is stated in `requirement.unmetRequirements` and logged as
 * `requirement_unmet` — and conflating it with a failed run would leave an
 * operator unable to tell a shortfall from a missing report.
 */
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

    const origin = classifyDatabaseOrigin(process.env[DATABASE_URL_ENV]);
    logger.info('database_origin_accepted', {
        stage: STAGE,
        ...originLogFields(origin),
    });

    const plan = loadCoveragePlan();
    const allowlist = loadEvidenceAllowlist();

    const scopedTo = parsed.options.category;
    if (scopedTo !== null && !plan.categories.some((entry) => entry.category === scopedTo)) {
        throw new CatalogReportError(
            `--category ${scopedTo} is not a category ${COVERAGE_PLAN_RELATIVE_PATH} declares. It declares: ` +
                `${plan.categories.map((entry) => entry.category).sort(compareStrings).join(', ')}.`,
            'unknown_category_filter',
        );
    }

    // ONE directory, decided here: the scoped-report guard, the publication
    // lock and both artefact writes are all about `destination.directory`. The
    // operator's own spelling is carried alongside it and named in the log and
    // in any refusal — it is what helps them recognise the run — but nothing is
    // ever written through it, because a spelling can be retargeted between the
    // guard and the rename and an identity cannot.
    const destination = resolveReportOutputDirectory({ options: parsed.options, logger });

    logger.info('stage_invoked', {
        stage: STAGE,
        outDir: destination.directory,
        namedOutDir: destination.named,
        canonicalReportDir: destination.canonicalReportDir,
        writesCommittedArtefacts: destination.writesCommittedArtefacts,
        categoryFilter: scopedTo,
    });

    // HERE rather than at module load: `src/prisma/client.ts` constructs the
    // client at import time, so importing this module for its exported
    // functions must not reach it (Rule backend-architecture §10, §11).
    const { prisma } = await import('../src/prisma/client');

    try {
        // BOTH PASSES INSIDE ONE SNAPSHOT. The aggregate figures and the
        // per-item records are two scans whose totals are reconciled against
        // each other, so they must read one catalog state; a concurrent
        // `catalog:load`, `catalog:validate` or `catalog:generate` between the
        // passes would otherwise produce a report that reconciles two states
        // and reads as consistent. The transaction is read-only by
        // construction — `ReportDb` exposes `findMany` and nothing else — so it
        // takes no row locks and blocks no writer; it only pins a snapshot.
        const outcome = await openReportSnapshot(prisma as unknown as SnapshotCapableClient, async (db) =>
            runReport({
                db,
                plan,
                allowlistVersion: allowlist.allowlistVersion,
                evidenceRegistrySnapshot: allowlist.registrySnapshot,
                options: parsed.options,
                outDir: destination.directory,
                logger,
                io: defaultReportIo(),
            }),
        );

        if (outcome.unmetRequirements.length > 0) {
            logger.warn('requirement_unmet', requirementFields(outcome));
        }

        logger.info('stage_completed', {
            stage: STAGE,
            rowsScanned: outcome.rowsScanned,
            publishedItems: outcome.publishedItems,
            publishedRows: outcome.publishedRows,
            itemRecords: outcome.itemRecords,
            quarantined: outcome.quarantined,
            perCategoryShortfallTotal: outcome.shortfallTotal,
            requirementMet: outcome.requirementMet,
            validationReport: outcome.validationReportPath,
            importReport: outcome.importReportPath,
        });

        return 0;
    } finally {
        await prisma.$disconnect();
    }
};

// Guarded so importing this module for parseArgs, describeUsage, the builders
// or runReport never runs the stage and never opens a database connection.
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
