// Stage 6 of the catalog pipeline: loading a reviewed release into an
// environment. This is the one catalog command an operator runs during a
// release (docs/meal-planning/release-and-recovery.md, step 4).
//
// WHAT THE STAGE DOES when its inputs are present: it verifies every file's
// SHA-256 against manifest.json before any write, then reconciles on stable
// identities — foods upsert on `source_key`, and each food's aliases, portions,
// components and validation record are replaced wholesale inside that food's
// transaction — retires a published food absent from a later release rather
// than deleting it, and refuses to move the active release pointer unless the
// row counts after the load equal the manifest's (Agent Action Plan §0.7.1
// Group 3). Rerunning it is a no-op.
//
// THE EMPTY components.jsonl IS LOADED, NOT SKIPPED. A release whose catalog is
// entirely source-backed single-ingredient records carries zero component rows,
// and that empty set is an assertion the loader must apply rather than ignore:
// because each food's components are replaced WHOLESALE, loading a release with
// no rows for a food is what removes a composition the previous release had, so
// treating the empty member as "nothing to do" would leave a stale composition
// behind and let a food's stored nutrition disagree with what it is derived
// from. The row-count reconciliation covers the member for the same reason — 0
// expected against 0 observed is a check that passed, not a check that was
// absent — and it is the load-time counterpart of the export-time invariant in
// catalog-release.ts: a published `ingredient_derived` food must carry at least
// one component row, so an empty components.jsonl is only ever valid alongside
// an empty published ingredient-derived set.
//
// THE ORDER OF THE RUN, which is the whole of its safety argument:
//   1. the input contract — `parseArgs` and `preflight` settle the release id,
//      its manifest's internal consistency and the presence of every file that
//      manifest lists, before a database client is even constructed;
//   2. VERIFICATION — every member is streamed once for its SHA-256, its byte
//      length and its row count, and compared against manifest.json. Nothing is
//      written on this path, so a tampered release is refused with the target
//      database untouched;
//   3. the run row — opened or resumed through scripts/lib/checkpoint.ts, which
//      is the single owner of `catalog_import_runs`;
//   4. RETIREMENT — a locally published food the release does not carry becomes
//      `retired` (see RETIRE, NEVER DELETE below);
//   5. RECONCILIATION — foods upsert on `source_key`, each food's children
//      replaced wholesale IN THAT FOOD'S OWN TRANSACTION, one short transaction
//      per food and none at all for a food the release does not change. A food
//      whose composition points forward, at a food this release carries but has
//      not loaded yet, is written NOWHERE in this step: the whole food is
//      deferred and applied by the fixpoint pass in `applyDeferredFoods`
//      through this same single-transaction path, so nothing incomplete is ever
//      committed (AAP §0.7.1 Group 3);
//   6. APPLIED-BYTE VERIFICATION — every member's digest, byte length and row
//      count are measured over the bytes the apply pass actually read and
//      compared against manifest.json a second time, which is what binds the
//      rows written to the bytes that were reviewed (see THE TWO READS below);
//   7. COUNT VERIFICATION — the published row counts after the load must equal
//      the manifest's, and the published ingredient-derived set must still carry
//      its compositions (`assessComponentCoverage`);
//   8. ACTIVATION — and only then is the run closed 'succeeded', which is what
//      makes it the active release. A load that fails anywhere above closes
//      'failed' and therefore never becomes the newest succeeded `release_load`
//      row: the previous release simply stays active, with no compensating write
//      and no pointer to roll back.
//
// THE TWO READS, AND WHY NEITHER IS TRUSTED ALONE. Verification (step 2) and the
// apply pass (step 5) each read the release from disk, so an edit between them
// would otherwise be applied unreviewed: a same-length change to one
// `display_name` keeps every byte length and row count intact, which no
// re-listing of the directory could detect. Two mechanisms close that window and
// neither is a copy of the release. A cheap FILE IDENTITY — size, modification
// time and inode, captured per member during verification — is compared before
// retirement and again as each member is opened, so the common case (a member
// replaced, truncated or regenerated between the passes) refuses before a row is
// written. And each apply-pass stream carries its OWN running SHA-256 and byte
// counter, compared against the manifest in step 6, so bytes that disagree with
// what was reviewed can never reach step 8 — the run closes 'failed', the
// pointer stays where it was, and a rerun over a correct release repairs it.
// SPOOLING THE RELEASE INTO VERIFIED COPIES WAS CONSIDERED AND REJECTED: it
// would copy ~70 MB per load and add a temp-file lifecycle to an operator
// command, while the property that actually matters — unreviewed bytes can never
// be activated — is what step 6 delivers on its own, under this file's existing
// failure model.
//
// `--dry-run` verifies (step 2) and then reports the reconciliation of steps 4
// and 5 as a comparison — the foods it would insert, update, retire and leave
// unchanged, and the alias, portion, composition and validation-record rows it
// would write and remove — issuing no statement and opening no transaction, and
// it performs step 6 over the bytes it read. It skips 3, 7 and 8 entirely and
// opens NO run row, exactly as
// catalog-import-usda.ts's dry run does: a run is claimed by
// (kind, manifest_version), so a dry run that claimed the release id would
// report what it would write and thereby stop the real load from ever writing
// it.
//
// RETIRE, NEVER DELETE. A food this release omits keeps its row and its id and
// becomes `publication_status = 'retired'`, because `recipe_ingredients` holds a
// RESTRICT foreign key into it and `meal_entries.catalog_food_id` a SET NULL
// one: deleting would either be refused by PostgreSQL or would silently detach a
// user's diary history. `retired` is written by this script and by nothing else.
// The reconciliation is symmetric — a later release that carries the food again
// restores it, because each release line states its own `publication_status` and
// a release is a statement of desired state rather than a delta.
//
// IDEMPOTENCE IS A REQUIREMENT, NOT AN OPTIMISATION (AAP §0.9.1): loading the
// same release twice must report 0 inserts and 0 updates and must issue no row
// write beyond the run row. It is achieved by comparing the stored food and its
// children against the release and skipping an unchanged food entirely — no
// transaction at all — because `catalog_foods.updated_at` is `@updatedAt` and
// 11,046 pointless transactions would both churn that column and turn the
// release gate into a benchmark.
//
// A PARTIAL LOAD IS REPAIRED BY RERUNNING IT (AAP §0.7.5), which is a property
// of the checkpoint and not a hope: the cursor's `lastSourceKey` is a WATERMARK
// over SETTLED foods only. It stops advancing the moment a food is deferred, so
// no checkpoint can ever name a position past a food this run has not finished,
// and a resumed run re-reads that food and everything after it — free, because
// re-reconciling a settled food is the no-op above.
//
// THE CONFIRMATION DOOR IS NOT THIS FILE'S. `catalog-load` is
// `development_or_confirmed` in scripts/lib/dbGuard.ts: against anything other
// than a development origin the guard demands `--confirm-target <dbname>` at
// module load, before this file's own code runs, and exits 1 with
// `{"event":"database_origin_refused","code":"confirmation_required"}` when it
// is absent. The flag is documented in the usage block below and accepted by
// the parser, but it is read from process.argv by the guard and never
// interpreted here — one owner for one rule.
//
// The two guard imports are ordered and load-bearing: Rule
// backend-architecture §10's IPv4-first DNS ordering, then that module-load
// classification, both ahead of anything that could reach Prisma or the network.
import './lib/bootstrap';
import './lib/dbGuard';

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import readline from 'readline';

import { classifyDatabaseOrigin, DatabaseOriginError } from './lib/dbGuard';
import { createFatalLogger, createLogger, safeError, writeLineSync } from './lib/logger';
import type { LogFields, LogLevel, ScriptLogger } from './lib/logger';
import {
    ManifestError,
    assertReleaseVersion,
    loadReleaseManifest,
    releaseDir,
    releaseFilePath,
} from './lib/manifest';
import type { CatalogReleaseManifest } from './lib/manifest';
import { ModelBudgetError } from './lib/budget';
import { RateLimitConfigError } from './lib/rateLimiter';
// checkpoint.ts is the single owner of `catalog_import_runs`, including the
// active-release pointer, so every run-state read and write below goes through
// it and this file never queries that table itself.
import {
    CheckpointError,
    RELEASE_LOAD_RUN_KIND,
    finishRun,
    getActiveReleaseLoad,
    openOrResumeRun,
    openRun,
    recordCounts,
    saveCursor,
    withCatalogStageLock,
} from './lib/checkpoint';
import type { CatalogRun, CatalogRunDb } from './lib/checkpoint';
// The zero-component rule, imported rather than restated: it is the same pure
// verdict catalog-release.ts asserts at export time, under unit test in
// src/services/__tests__/catalog.logic.test.ts. catalog.logic.ts touches no
// Prisma client, no filesystem and no clock, so importing it costs this entry
// point nothing at module load.
import { assessComponentCoverage } from '../src/services/catalog.logic';

const STAGE = 'catalog-load';

const RELEASE_FLAG = '--release';

const DRY_RUN_FLAG = '--dry-run';

const logger = createLogger(STAGE);

// ---------------------------------------------------------------------------
// The release format contract.
//
// The five members catalog-release.ts writes, named here rather than imported
// from it: each one maps to a different table and a different line shape, so
// this loader has to know them individually anyway, and naming them locally
// keeps the two entry points independent of each other's module graph.
// ---------------------------------------------------------------------------

const FOODS_FILE = 'foods.jsonl';
const ALIASES_FILE = 'aliases.jsonl';
const PORTIONS_FILE = 'portions.jsonl';
const COMPONENTS_FILE = 'components.jsonl';
const VALIDATION_RECORDS_FILE = 'validation-records.jsonl';

/**
 * Every member a release must carry, paired with the `counts` key that states
 * its row count. A member is verified whether or not it has rows: an empty
 * `components.jsonl` is an asserted empty composition set (see the header), so
 * 0 expected against 0 observed is a check that passed, not one that was
 * skipped.
 */
const RELEASE_MEMBERS: readonly { readonly file: string; readonly countKey: keyof CatalogReleaseManifest['counts'] }[] = [
    { file: FOODS_FILE, countKey: 'foods' },
    { file: ALIASES_FILE, countKey: 'aliases' },
    { file: PORTIONS_FILE, countKey: 'portions' },
    { file: COMPONENTS_FILE, countKey: 'components' },
    { file: VALIDATION_RECORDS_FILE, countKey: 'validation_records' },
];

const PUBLISHED = 'published';
const RETIRED = 'retired';

/** The provenance whose nutrition is derived from a stored composition. */
const INGREDIENT_DERIVED = 'ingredient_derived';

// ---------------------------------------------------------------------------
// Failure.
// ---------------------------------------------------------------------------

/**
 * A discriminated code rather than a message to match on (Rule
 * backend-architecture §8), because an operator acts on each of these
 * differently.
 *
 * `release_*` codes mean the artefact and its manifest disagree, or the
 * artefact is internally inconsistent — the release has to be reproduced or
 * restored, and nothing was written for the ones raised during verification.
 * `release_file_changed_during_load` is the one raised between the two reads:
 * the member the apply pass opened, or the bytes it actually read, are not the
 * ones verification measured, so the load is refused rather than applying
 * unreviewed bytes (see THE TWO READS in this file's header).
 * `component_reference_unresolved` means a composition names a food neither
 * this database nor the release can ever supply — an absent target, or a cycle
 * the fixpoint pass cannot break — which the RESTRICT foreign key would refuse:
 * it is reported with both keys rather than silently skipped, because skipping
 * it would store a nutrient total with no composition behind it.
 * `count_verification_failed` and `component_coverage_failed` mean the load
 * applied but the result does not match what the release promised, so the run
 * is closed 'failed' and the active release pointer stays where it was.
 */
export type CatalogLoadErrorCode =
    | 'release_id_mismatch'
    | 'release_file_unreadable'
    | 'release_line_invalid_json'
    | 'release_line_invalid_field'
    | 'release_file_digest_mismatch'
    | 'release_file_size_mismatch'
    | 'release_file_row_count_mismatch'
    | 'release_file_changed_during_load'
    | 'release_member_not_listed'
    | 'release_published_count_mismatch'
    | 'release_duplicate_food'
    | 'release_duplicate_child'
    | 'release_child_without_food'
    | 'release_member_out_of_order'
    | 'release_duplicate_validation_record'
    | 'release_validation_record_missing'
    | 'component_reference_unresolved'
    | 'count_verification_failed'
    | 'component_coverage_failed';

/**
 * Where the refusal came from, so a message never has to be parsed to find out.
 * Every field is optional because the codes above fail at different
 * granularities — a member, a line within it, a food, or a count.
 */
export interface CatalogLoadErrorContext {
    readonly file?: string;
    readonly line?: number;
    readonly sourceKey?: string;
    readonly componentSourceKey?: string;
    readonly expected?: string | number;
    readonly observed?: string | number;
}

/**
 * Follows the `DailyQuotaError` template in src/services/entitlement.service.ts
 * (Rule backend-architecture §8): a named class carrying the data the caller
 * needs rather than a string. `describeFailure` reports the code and
 * `main` maps it to exit 1.
 */
export class CatalogLoadError extends Error {
    constructor(
        public readonly code: CatalogLoadErrorCode,
        message: string,
        public readonly context: CatalogLoadErrorContext = {},
    ) {
        super(message);
        this.name = 'CatalogLoadError';
    }
}

// ---------------------------------------------------------------------------
// Argument parsing — pure (Rule backend-architecture §1.2).
// ---------------------------------------------------------------------------

export interface LoadOptions {
    readonly help: boolean;
    /** The release id exactly as the operator typed it; validated in preflight. */
    readonly release: string;
    /**
     * Verify the release and report the reconciliation it would apply, writing
     * nothing and opening no run row — see the header for why a dry run must
     * stay out of the run ledger entirely.
     */
    readonly dryRun: boolean;
}

export interface ArgumentError {
    readonly flag: string;
    readonly message: string;
}

export type ParseResult =
    | { readonly ok: true; readonly options: LoadOptions }
    | { readonly ok: false; readonly errors: readonly ArgumentError[] };

export interface PrerequisiteGap {
    readonly code: string;
    readonly requirement: string;
    readonly remedy: string;
    readonly detail?: string;
}

const HELP_FLAGS: readonly string[] = ['--help', '-h'];

// Owned by scripts/lib/dbGuard.ts (see the header): consumed with its value so
// it is not mistaken for a positional argument, and deliberately not
// interpreted here.
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
        return { ok: true, options: { help: true, release: '', dryRun: false } };
    }

    const errors: ArgumentError[] = [];
    let release: string | null = null;
    let releaseSeen = false;
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

    while (index < argv.length) {
        const { flag, inlineValue } = splitToken(argv[index]);
        index += 1;

        if (flag === RELEASE_FLAG) {
            // Marked seen before its value is read, so a flag given without one
            // is reported as the missing value it is and not additionally as an
            // absent flag — the operator has one thing to fix, not two.
            const alreadySeen = releaseSeen;
            releaseSeen = true;

            const value = takeValue(inlineValue);
            if (value === null) {
                errors.push({ flag, message: `${flag} requires a release id such as v1` });
                continue;
            }
            if (alreadySeen) {
                errors.push({ flag, message: `${flag} was given more than once; it takes a single value` });
                continue;
            }
            release = value;
            continue;
        }

        if (flag === DRY_RUN_FLAG) {
            // A boolean flag, so an inline value is a mistake worth naming
            // rather than ignoring: `--dry-run=false` would otherwise read as a
            // request NOT to dry run and be honoured as the opposite.
            if (inlineValue !== null) {
                errors.push({ flag, message: `${flag} takes no value` });
                continue;
            }
            dryRun = true;
            continue;
        }

        if (flag === CONFIRM_TARGET_FLAG) {
            takeValue(inlineValue);
            continue;
        }

        errors.push({ flag, message: `${flag} is not a flag ${STAGE} accepts` });
    }

    // Required with no default: which release is loaded into an environment is
    // never something this command should decide on the operator's behalf.
    if (!releaseSeen) {
        errors.push({ flag: RELEASE_FLAG, message: `${RELEASE_FLAG} is required; name the release to load, such as v1` });
    }

    if (errors.length > 0) {
        return { ok: false, errors };
    }

    return { ok: true, options: { help: false, release: release === null ? '' : release, dryRun } };
};

// ---------------------------------------------------------------------------
// Usage.
// ---------------------------------------------------------------------------

export const describeUsage = (): string =>
    [
        `Usage: npm run catalog:load -- --release <vN> [options]   (${STAGE})`,
        '',
        'Applies a reviewed catalog release to the database DATABASE_URL names.',
        'Every file is checksum-verified against manifest.json before anything is',
        'written; foods reconcile on source_key with their aliases, portions,',
        'components and validation record replaced wholesale; a published food the',
        'release does not carry is retired, never deleted; and the run is recorded',
        'as succeeded — which is what makes it the active release — only once the',
        'published row counts after the load equal the manifest\'s. Loading the same',
        'release again reports 0 inserts and 0 updates.',
        '',
        'Options:',
        '  --release <vN>              Required. The release id to load: "v" followed',
        '                              by digits, naming',
        '                              data/meal-planning/catalog/releases/<vN>/.',
        '  --dry-run                   Verify the release and report the',
        '                              reconciliation it would apply: the foods it',
        '                              would insert, update, retire and leave',
        '                              unchanged, and the alias, portion, composition',
        '                              and validation-record rows it would write and',
        '                              remove. Writes nothing and opens no run row, so',
        '                              the release still has to be loaded afterwards.',
        '  --confirm-target <dbname>   Required by scripts/lib/dbGuard.ts, which owns',
        '                              this flag, whenever DATABASE_URL is not a',
        '                              development origin: it must name that URL\'s',
        '                              database exactly. Without it the guard refuses',
        '                              the run at module load with',
        '                              code "confirmation_required". Never needed',
        '                              against a development origin.',
        '  --help, -h                  Print this usage block and exit 0.',
        '',
        'Inputs read:',
        '  data/meal-planning/catalog/releases/<vN>/manifest.json   release id, the',
        '                              per-file SHA-256, the row counts and the source',
        '                              dataset and model versions',
        '  data/meal-planning/catalog/releases/<vN>/*.jsonl         every file the',
        '                              manifest lists: foods, aliases, portions,',
        '                              components and validation records',
        '',
        'Environment:',
        '  DATABASE_URL   required; classified by scripts/lib/dbGuard.ts. This is the',
        '                 environment the release is loaded into.',
    ].join('\n');

const writeUsage = (level: LogLevel): void => {
    writeLineSync(describeUsage(), level);
};

// ---------------------------------------------------------------------------
// Preflight.
// ---------------------------------------------------------------------------

export interface LoadPreflightDeps {
    readonly env: NodeJS.ProcessEnv;
    readonly release: string;
    /** manifest.ts's release id rule, seamed so the invalid-id branch is testable. */
    readonly assertReleaseVersion: (release: string) => string;
    readonly loadReleaseManifest: (release: string) => CatalogReleaseManifest;
    readonly releaseFilePath: (release: string, fileName: string) => string;
    readonly fileExists: (absolutePath: string) => boolean;
}

const defaultPreflightDeps = (release: string): LoadPreflightDeps => ({
    env: process.env,
    release,
    assertReleaseVersion,
    loadReleaseManifest,
    releaseFilePath,
    fileExists: (absolutePath: string): boolean => fs.existsSync(absolutePath),
});

/**
 * Names a release file the way the operator sees it — repository-relative —
 * rather than by its absolute path, which is machine-specific and would end up
 * in a committed log.
 */
const describeReleaseFile = (release: string, fileName: string): string =>
    `data/meal-planning/catalog/releases/${release}/${fileName}`;

const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/;

const isRowCount = (value: unknown): value is number =>
    typeof value === 'number' && Number.isInteger(value) && value >= 0;

/**
 * The manifest's INTERNAL consistency, checked before a byte of the release is
 * read: is every member listed exactly once, does each entry carry the digest
 * and counts a verification needs, and does the `counts` block agree with the
 * per-file row counts?
 *
 * These are input-contract failures rather than load failures, which is why
 * they are `PrerequisiteGap`s here and not `CatalogLoadError`s: each one has a
 * requirement an operator can read and a remedy they can run, and none of them
 * needs a database connection to detect. A digest that does not MATCH its file
 * is the other kind — it is discovered by reading the file, and it is raised
 * from the verification step.
 *
 * `counts.validation_records` is compared with `counts.foods` because a release
 * exports published foods only and catalog-release.ts refuses to export a
 * published food with no validation record. A manifest where the two disagree
 * therefore describes a release that ships unevidenced rows, which AAP §0.1.1
 * forbids, and no amount of loading can repair it.
 */
const manifestConsistencyGaps = (
    release: string,
    manifest: CatalogReleaseManifest,
    files: readonly CatalogReleaseManifest['files'][number][],
): readonly PrerequisiteGap[] => {
    const gaps: PrerequisiteGap[] = [];
    const reproduce = `Reproduce the release with "npm run catalog:release -- --release ${release} --force".`;

    const byFile = new Map<string, { sha256: unknown; row_count: unknown; bytes: unknown }>();
    for (const file of files) {
        if (file === null || typeof file !== 'object' || typeof file.path !== 'string') {
            continue;
        }
        byFile.set(file.path, { sha256: file.sha256, row_count: file.row_count, bytes: file.bytes });
    }

    const known = new Set(RELEASE_MEMBERS.map((member) => member.file));
    for (const listed of byFile.keys()) {
        if (!known.has(listed)) {
            gaps.push({
                code: 'release_manifest_member_unknown',
                requirement: `${describeReleaseFile(release, 'manifest.json')} must list exactly the release's five members; "${listed}" is not one of them`,
                remedy: `${reproduce} A member this loader cannot apply would be verified and then ignored, which is worse than refusing it.`,
            });
        }
    }

    const counts: Record<string, unknown> =
        manifest.counts === null || typeof manifest.counts !== 'object'
            ? {}
            : (manifest.counts as unknown as Record<string, unknown>);

    for (const member of RELEASE_MEMBERS) {
        const entry = byFile.get(member.file);
        if (entry === undefined) {
            gaps.push({
                code: 'release_manifest_member_missing',
                requirement: `${describeReleaseFile(release, 'manifest.json')} must list ${member.file} with its SHA-256, row count and byte length`,
                remedy: `${reproduce} Every member is verified before any write, so one that is not described cannot be applied.`,
            });
            continue;
        }

        if (typeof entry.sha256 !== 'string' || !SHA256_HEX_PATTERN.test(entry.sha256)) {
            gaps.push({
                code: 'release_manifest_digest_invalid',
                requirement: `The ${member.file} entry in ${describeReleaseFile(release, 'manifest.json')} must carry a 64-character lower-case hex "sha256"`,
                remedy: `${reproduce} A member with no usable digest cannot be verified, and loading it unverified is not an option this stage offers.`,
                detail: `sha256: ${JSON.stringify(entry.sha256)}`,
            });
        }

        if (!isRowCount(entry.row_count) || !isRowCount(entry.bytes)) {
            gaps.push({
                code: 'release_manifest_measurements_invalid',
                requirement: `The ${member.file} entry in ${describeReleaseFile(release, 'manifest.json')} must carry a whole non-negative "row_count" and "bytes"`,
                remedy: reproduce,
                detail: `row_count: ${JSON.stringify(entry.row_count)}, bytes: ${JSON.stringify(entry.bytes)}`,
            });
            continue;
        }

        const declared = counts[member.countKey];
        if (!isRowCount(declared) || declared !== entry.row_count) {
            gaps.push({
                code: 'release_manifest_counts_disagree',
                requirement: `${describeReleaseFile(release, 'manifest.json')} must state counts.${String(member.countKey)} equal to ${member.file}'s row_count (${entry.row_count})`,
                remedy: `${reproduce} The counts block is what the row counts after a load are compared against, so a manifest that disagrees with itself cannot settle whether a load was complete.`,
                detail: `counts.${String(member.countKey)}: ${JSON.stringify(declared)}`,
            });
        }
    }

    const foods = counts.foods;
    const publishedFoods = counts.published_foods;
    if (publishedFoods !== undefined && (!isRowCount(publishedFoods) || publishedFoods !== foods)) {
        gaps.push({
            code: 'release_manifest_published_count_disagrees',
            requirement: `${describeReleaseFile(release, 'manifest.json')} must state counts.published_foods equal to counts.foods (${JSON.stringify(foods)}): a release exports published foods only`,
            remedy: reproduce,
            detail: `counts.published_foods: ${JSON.stringify(publishedFoods)}`,
        });
    }

    const validationRecords = counts.validation_records;
    if (isRowCount(foods) && isRowCount(validationRecords) && validationRecords !== foods) {
        gaps.push({
            code: 'release_validation_records_incomplete',
            requirement: `${describeReleaseFile(release, 'manifest.json')} must state one validation record per food (counts.foods ${foods})`,
            remedy: `Run "npm run catalog:validate" and then ${reproduce.slice(0, 1).toLowerCase()}${reproduce.slice(1)}`,
            detail: `counts.validation_records: ${validationRecords}`,
        });
    }

    return gaps;
};

export const preflight = (deps: LoadPreflightDeps): readonly PrerequisiteGap[] => {
    const gaps: PrerequisiteGap[] = [];

    // Every path below is built from the id, so an invalid one is the whole
    // answer: there is no manifest to look for and no file list to check.
    try {
        deps.assertReleaseVersion(deps.release);
    } catch (error) {
        if (error instanceof ManifestError) {
            gaps.push({
                code: 'release_id_invalid',
                requirement: 'The --release value must be "v" followed by digits, and a single path segment',
                remedy: 'Pass a release id such as --release v1.',
                detail: `${error.code}: ${error.message}`,
            });
            return gaps;
        }
        throw error;
    }

    let manifest: CatalogReleaseManifest;
    try {
        manifest = deps.loadReleaseManifest(deps.release);
    } catch (error) {
        if (error instanceof ManifestError) {
            gaps.push({
                code: 'release_manifest_unavailable',
                requirement: `${describeReleaseFile(deps.release, 'manifest.json')} must load and declare the coverage-plan version this build understands`,
                remedy: `Produce the release with "npm run catalog:release -- --release ${deps.release}" and commit data/meal-planning/catalog/releases/${deps.release}/ (AAP §0.7.1 Group 3).`,
                detail: `${error.code}: ${error.message}`,
            });
            // Without the manifest there is no file list, so the per-file check
            // below has nothing to say. Returning here keeps the refusal to the
            // one thing the operator has to fix first.
            return gaps;
        }
        throw error;
    }

    // The manifest names the release it describes, and this command names the
    // release it was asked to load. When those disagree, one of the two is
    // wrong and there is no reading of the pair that is safe to act on — a
    // manifest for v2 sitting in the v1 directory would otherwise be verified
    // against v2's digests and loaded as v1, so the active-release pointer
    // would then name a release nobody produced.
    if (typeof manifest.release_id !== 'string' || manifest.release_id !== deps.release) {
        gaps.push({
            code: 'release_id_mismatch',
            requirement: `${describeReleaseFile(deps.release, 'manifest.json')} must declare "release_id": "${deps.release}"`,
            remedy: `Load the release the manifest names, or reproduce ${deps.release} with "npm run catalog:release -- --release ${deps.release} --force".`,
            detail: `release_id: ${JSON.stringify(manifest.release_id)}`,
        });
        return gaps;
    }

    // Guarded rather than trusted: the manifest is a JSON document on disk, so
    // its declared type does not bind what actually arrives, and a missing
    // `files` array must read as "the manifest does not list its files" rather
    // than throwing inside a preflight check.
    const files = Array.isArray(manifest.files) ? manifest.files : [];
    if (files.length === 0) {
        gaps.push({
            code: 'release_manifest_lists_no_files',
            requirement: `${describeReleaseFile(deps.release, 'manifest.json')} must list the release's files with a SHA-256 and a row count each`,
            remedy: `Reproduce the release with "npm run catalog:release -- --release ${deps.release} --force"; a manifest with no file list cannot be checksum-verified.`,
        });
        return gaps;
    }

    gaps.push(...manifestConsistencyGaps(deps.release, manifest, files));

    for (const file of files) {
        const fileName = file === null || typeof file !== 'object' ? '' : String(file.path);

        let absolutePath: string;
        try {
            absolutePath = deps.releaseFilePath(deps.release, fileName);
        } catch (error) {
            if (error instanceof ManifestError) {
                // A name the path rule refuses — a separator, "..", an empty
                // entry — is a defective manifest, not a missing file.
                gaps.push({
                    code: 'release_file_name_invalid',
                    requirement: `Every "path" in ${describeReleaseFile(deps.release, 'manifest.json')} must be a single file name inside the release directory`,
                    remedy: `Reproduce the release with "npm run catalog:release -- --release ${deps.release} --force" so its manifest lists plain file names.`,
                    detail: `${error.code}: ${error.message}`,
                });
                continue;
            }
            throw error;
        }

        if (!deps.fileExists(absolutePath)) {
            gaps.push({
                code: 'release_file_missing',
                requirement: `${describeReleaseFile(deps.release, fileName)} must exist: the manifest lists it, and every file is checksum-verified before any write`,
                remedy: `Restore the file, or reproduce the release with "npm run catalog:release -- --release ${deps.release} --force".`,
            });
        }
    }

    return gaps;
};

// ---------------------------------------------------------------------------
// The release on disk.
//
// Every line is external input — a JSON document in a repository — so it is
// READ rather than asserted: each field is taken through a reader that names
// the member, the line and the field it refused. The shapes are the inverse of
// catalog-release.ts's `toReleaseFoodLine` and `toReleaseValidationLine`, which
// is the only place they are produced.
// ---------------------------------------------------------------------------

type ReleaseRow = Record<string, unknown>;

const fieldError = (file: string, line: number, field: string, problem: string): CatalogLoadError =>
    new CatalogLoadError('release_line_invalid_field', `${file} line ${line}: "${field}" ${problem}`, {
        file,
        line,
    });

const readText = (row: ReleaseRow, field: string, file: string, line: number): string => {
    const value = row[field];
    if (typeof value !== 'string' || value.length === 0) {
        throw fieldError(file, line, field, 'must be a non-empty string');
    }
    return value;
};

const readNullableText = (row: ReleaseRow, field: string, file: string, line: number): string | null => {
    const value = row[field];
    if (value === null || value === undefined) {
        return null;
    }
    if (typeof value !== 'string') {
        throw fieldError(file, line, field, 'must be a string or null');
    }
    return value;
};

const readNumber = (row: ReleaseRow, field: string, file: string, line: number): number => {
    const value = row[field];
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw fieldError(file, line, field, 'must be a finite number');
    }
    return value;
};

const readNullableNumber = (row: ReleaseRow, field: string, file: string, line: number): number | null => {
    const value = row[field];
    if (value === null || value === undefined) {
        return null;
    }
    return readNumber(row, field, file, line);
};

const readInteger = (row: ReleaseRow, field: string, file: string, line: number): number => {
    const value = readNumber(row, field, file, line);
    if (!Number.isInteger(value)) {
        throw fieldError(file, line, field, 'must be a whole number');
    }
    return value;
};

const readNullableInteger = (row: ReleaseRow, field: string, file: string, line: number): number | null => {
    const value = row[field];
    if (value === null || value === undefined) {
        return null;
    }
    return readInteger(row, field, file, line);
};

const readFlag = (row: ReleaseRow, field: string, file: string, line: number): boolean => {
    const value = row[field];
    if (typeof value !== 'boolean') {
        throw fieldError(file, line, field, 'must be true or false');
    }
    return value;
};

const readTextList = (row: ReleaseRow, field: string, file: string, line: number): string[] => {
    const value = row[field];
    if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
        throw fieldError(file, line, field, 'must be an array of strings');
    }
    return value as string[];
};

/**
 * A `jsonb` column's value, taken verbatim.
 *
 * `undefined` is refused rather than defaulted: these columns are NOT NULL in
 * the schema (`canonical_identity`, `portion_units`, `identity_evidence`,
 * `checks`, `source_versions`, `history`), so an absent field is a release that
 * cannot be stored, and substituting a value here would invent evidence.
 */
const readJson = (row: ReleaseRow, field: string, file: string, line: number): unknown => {
    const value = row[field];
    if (value === undefined) {
        throw fieldError(file, line, field, 'is required');
    }
    return value;
};

/** An ISO timestamp the schema stores as `DateTime`. */
const readTimestamp = (row: ReleaseRow, field: string, file: string, line: number): Date => {
    const value = readText(row, field, file, line);
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) {
        throw fieldError(file, line, field, 'must be an ISO timestamp');
    }
    return parsed;
};

const readNullableTimestamp = (row: ReleaseRow, field: string, file: string, line: number): Date | null =>
    row[field] === null || row[field] === undefined ? null : readTimestamp(row, field, file, line);

/** Every `catalog_foods` column a release states, in the schema's spelling. */
interface FoodScalars {
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
}

/**
 * What is actually written: the release's scalars plus the LOCAL batch id the
 * portable `generation_batch_key` resolved to.
 *
 * `id` and `search_vector` are absent by construction and must stay so. The
 * primary key is local — a release carries none, which is what lets a reloaded
 * food keep the id `recipe_ingredients` and `meal_entries` already point at —
 * and `search_vector` is a STORED generated column PostgreSQL computes from
 * `search_text`, so writing it would attempt to overwrite a derivation the
 * database owns.
 */
interface FoodColumns extends FoodScalars {
    readonly generation_batch_id: string | null;
}

interface PortionColumns {
    readonly description: string;
    readonly amount: number;
    readonly unit: string;
    readonly gram_weight: number;
    readonly is_default: boolean;
    readonly source: string;
}

interface ComponentSpec {
    /** The portable reference the release carries; remapped to a local id at write time. */
    readonly componentSourceKey: string;
    readonly quantity_grams: number;
    readonly yield_factor: number;
    readonly component_nutrition_version: number;
    readonly sort_order: number;
    readonly line: number;
}

interface ValidationColumns {
    readonly canonical_identity: unknown;
    readonly aliases: string[];
    readonly category: string;
    readonly food_state: string;
    readonly identity_source: string;
    readonly identity_status: string;
    readonly nutrition_provenance: string;
    readonly nutrition_method: string;
    /**
     * The inverse of `toReleaseValidationLine`: the release states the
     * assumptions as an array and the column is `String?`, so the array is
     * re-encoded as the JSON text the importer stores and the exporter parses.
     */
    readonly nutrition_assumptions: string;
    readonly portion_units: unknown;
    readonly identity_evidence: unknown;
    readonly checks: unknown;
    readonly llm_review: unknown;
    readonly outcome: string;
    readonly reviewed_at: Date;
    readonly publication_status: string;
    readonly source_versions: unknown;
    readonly history: unknown;
}

const parseFoodLine = (row: ReleaseRow, line: number): { scalars: FoodScalars; generationBatchKey: string | null } => {
    const file = FOODS_FILE;

    return {
        scalars: {
            source_key: readText(row, 'source_key', file, line),
            canonical_name: readText(row, 'canonical_name', file, line),
            display_name: readText(row, 'display_name', file, line),
            category: readText(row, 'category', file, line),
            food_state: readText(row, 'food_state', file, line),
            food_group: readText(row, 'food_group', file, line),
            identity_source: readText(row, 'identity_source', file, line),
            identity_status: readText(row, 'identity_status', file, line),
            nutrition_provenance: readText(row, 'nutrition_provenance', file, line),
            publication_status: readText(row, 'publication_status', file, line),
            nutrition_basis: readText(row, 'nutrition_basis', file, line),
            basis_amount: readNumber(row, 'basis_amount', file, line),
            calories: readNullableNumber(row, 'calories', file, line),
            protein_g: readNullableNumber(row, 'protein_g', file, line),
            carbs_g: readNullableNumber(row, 'carbs_g', file, line),
            fat_g: readNullableNumber(row, 'fat_g', file, line),
            fiber_g: readNullableNumber(row, 'fiber_g', file, line),
            density_g_per_ml: readNullableNumber(row, 'density_g_per_ml', file, line),
            allergen_tags: readTextList(row, 'allergen_tags', file, line),
            allergen_status: readText(row, 'allergen_status', file, line),
            diet_tags: readTextList(row, 'diet_tags', file, line),
            is_common_dislike: readFlag(row, 'is_common_dislike', file, line),
            cost_class: readInteger(row, 'cost_class', file, line),
            nutrition_version: readInteger(row, 'nutrition_version', file, line),
            metadata_version: readInteger(row, 'metadata_version', file, line),
            usda_fdc_id: readNullableInteger(row, 'usda_fdc_id', file, line),
            usda_data_type: readNullableText(row, 'usda_data_type', file, line),
            usda_description: readNullableText(row, 'usda_description', file, line),
            source_version: readNullableText(row, 'source_version', file, line),
            source_cache_key: readNullableText(row, 'source_cache_key', file, line),
            search_text: readNullableText(row, 'search_text', file, line),
            imported_at: readNullableTimestamp(row, 'imported_at', file, line),
        },
        generationBatchKey: readNullableText(row, 'generation_batch_key', file, line),
    };
};

const parsePortionLine = (row: ReleaseRow, line: number): PortionColumns => ({
    description: readText(row, 'description', PORTIONS_FILE, line),
    amount: readNumber(row, 'amount', PORTIONS_FILE, line),
    unit: readText(row, 'unit', PORTIONS_FILE, line),
    gram_weight: readNumber(row, 'gram_weight', PORTIONS_FILE, line),
    is_default: readFlag(row, 'is_default', PORTIONS_FILE, line),
    source: readText(row, 'source', PORTIONS_FILE, line),
});

const parseComponentLine = (row: ReleaseRow, line: number): ComponentSpec => ({
    componentSourceKey: readText(row, 'component_food_source_key', COMPONENTS_FILE, line),
    quantity_grams: readNumber(row, 'quantity_grams', COMPONENTS_FILE, line),
    yield_factor: readNumber(row, 'yield_factor', COMPONENTS_FILE, line),
    component_nutrition_version: readInteger(row, 'component_nutrition_version', COMPONENTS_FILE, line),
    sort_order: readInteger(row, 'sort_order', COMPONENTS_FILE, line),
    line,
});

const parseValidationLine = (row: ReleaseRow, line: number): ValidationColumns => {
    const file = VALIDATION_RECORDS_FILE;
    const assumptions = row.nutrition_assumptions;
    if (!Array.isArray(assumptions)) {
        throw fieldError(file, line, 'nutrition_assumptions', 'must be an array');
    }

    return {
        canonical_identity: readJson(row, 'canonical_identity', file, line),
        aliases: readTextList(row, 'aliases', file, line),
        category: readText(row, 'category', file, line),
        food_state: readText(row, 'food_state', file, line),
        identity_source: readText(row, 'identity_source', file, line),
        identity_status: readText(row, 'identity_status', file, line),
        nutrition_provenance: readText(row, 'nutrition_provenance', file, line),
        nutrition_method: readText(row, 'nutrition_method', file, line),
        nutrition_assumptions: JSON.stringify(assumptions),
        portion_units: readJson(row, 'portion_units', file, line),
        identity_evidence: readJson(row, 'identity_evidence', file, line),
        checks: readJson(row, 'checks', file, line),
        // Nullable in the schema and null for every row a model never reviewed,
        // so it is read as "present or absent" rather than required.
        llm_review: row.llm_review === undefined ? null : row.llm_review,
        outcome: readText(row, 'outcome', file, line),
        reviewed_at: readTimestamp(row, 'reviewed_at', file, line),
        publication_status: readText(row, 'publication_status', file, line),
        source_versions: readJson(row, 'source_versions', file, line),
        history: readJson(row, 'history', file, line),
    };
};

// ---------------------------------------------------------------------------
// Comparing what is stored with what the release states.
//
// This is what makes a rerun a no-op, so it is exact rather than approximate:
// a comparison that reported "unchanged" too readily would leave a stale row
// behind, and one that reported "changed" too readily would churn
// `catalog_foods.updated_at` on every load and turn the release gate into
// 11,046 pointless transactions.
// ---------------------------------------------------------------------------

/**
 * How many significant digits of a JSON number a comparison may rely on.
 *
 * A stored `jsonb` number does not always read back as the exact double the
 * release stated: writing `1.0699999999999932` through the client and reading
 * it back yields `1.069999999999993`, because the value is re-serialised with
 * 16 significant digits on the way in (PostgreSQL itself is exact —
 * `'{"a":1.0699999999999932}'::jsonb` round-trips unchanged — so the digit is
 * lost before the statement reaches it).
 *
 * 15 is the threshold below that: every IEEE-754 double survives a
 * decimal→binary→decimal round trip at 15 significant digits, so two numbers
 * that agree here agree to within one part in 10^15. These are validation
 * measurements — kcal per 100 g, macro mass, a percentage gap — where a
 * difference that small is not a difference, and the alternative is a rerun
 * that rewrites every validation record whose evidence happens to carry a
 * 17-digit double.
 */
const COMPARABLE_SIGNIFICANT_DIGITS = 15;

/**
 * A stable serialization for comparing `jsonb` values.
 *
 * Keys are sorted recursively because PostgreSQL does NOT preserve a stored
 * object's key order — `jsonb` normalises it — so comparing the two documents
 * as written would report a difference on every load for values that are
 * identical. Array order IS preserved by the column and is therefore preserved
 * here: the order of `checks` and `identity_evidence` is part of the record.
 *
 * Numbers are normalised to {@link COMPARABLE_SIGNIFICANT_DIGITS} for the same
 * reason the keys are sorted: what comes back out of the column is compared,
 * not what went in.
 */
const canonicalJson = (value: unknown): string => {
    if (typeof value === 'number') {
        return Number.isFinite(value)
            ? JSON.stringify(Number(value.toPrecision(COMPARABLE_SIGNIFICANT_DIGITS)))
            : 'null';
    }
    if (value === null || typeof value !== 'object') {
        return JSON.stringify(value) ?? 'null';
    }
    if (Array.isArray(value)) {
        return `[${value.map(canonicalJson).join(',')}]`;
    }
    const entries = Object.entries(value as Record<string, unknown>)
        .filter(([, entry]) => entry !== undefined)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`);
    return `{${entries.join(',')}}`;
};

const sameTextList = (stored: readonly string[] | null, desired: readonly string[]): boolean => {
    const left = stored ?? [];
    return left.length === desired.length && left.every((entry, index) => entry === desired[index]);
};

const sameTimestamp = (stored: Date | null, desired: Date | null): boolean => {
    if (stored === null || desired === null) {
        return stored === desired;
    }
    return stored.getTime() === desired.getTime();
};

/**
 * Whether two column values are the same value.
 *
 * Numbers are compared at {@link COMPARABLE_SIGNIFICANT_DIGITS} for the reason
 * given there — a 17-significant-digit double comes back out of a `double
 * precision` column with 16 digits, exactly as it does out of `jsonb` — so an
 * exact comparison would report a difference no release states, and every load
 * would rewrite that food. Every other type is compared identically.
 */
const sameValue = (stored: unknown, desired: unknown): boolean => {
    if (typeof stored === 'number' && typeof desired === 'number') {
        return (
            stored === desired ||
            (Number.isFinite(stored) &&
                Number.isFinite(desired) &&
                stored.toPrecision(COMPARABLE_SIGNIFICANT_DIGITS) ===
                    desired.toPrecision(COMPARABLE_SIGNIFICANT_DIGITS))
        );
    }
    return stored === desired;
};

const FOOD_SCALAR_KEYS: readonly (keyof FoodScalars)[] = [
    'source_key',
    'canonical_name',
    'display_name',
    'category',
    'food_state',
    'food_group',
    'identity_source',
    'identity_status',
    'nutrition_provenance',
    'publication_status',
    'nutrition_basis',
    'basis_amount',
    'calories',
    'protein_g',
    'carbs_g',
    'fat_g',
    'fiber_g',
    'density_g_per_ml',
    'allergen_status',
    'is_common_dislike',
    'cost_class',
    'nutrition_version',
    'metadata_version',
    'usda_fdc_id',
    'usda_data_type',
    'usda_description',
    'source_version',
    'source_cache_key',
    'search_text',
];

const sameFoodColumns = (stored: StoredFoodRow, desired: FoodColumns): boolean =>
    FOOD_SCALAR_KEYS.every((key) => sameValue(stored[key], desired[key])) &&
    sameTextList(stored.allergen_tags, desired.allergen_tags) &&
    sameTextList(stored.diet_tags, desired.diet_tags) &&
    sameTimestamp(stored.imported_at, desired.imported_at) &&
    stored.generation_batch_id === desired.generation_batch_id;

const samePortion = (stored: PortionColumns, desired: PortionColumns): boolean =>
    sameValue(stored.amount, desired.amount) &&
    stored.unit === desired.unit &&
    sameValue(stored.gram_weight, desired.gram_weight) &&
    stored.is_default === desired.is_default &&
    stored.source === desired.source;

const sameValidationRecord = (stored: StoredValidationRow, desired: ValidationColumns): boolean =>
    stored.category === desired.category &&
    stored.food_state === desired.food_state &&
    stored.identity_source === desired.identity_source &&
    stored.identity_status === desired.identity_status &&
    stored.nutrition_provenance === desired.nutrition_provenance &&
    stored.nutrition_method === desired.nutrition_method &&
    stored.nutrition_assumptions === desired.nutrition_assumptions &&
    stored.outcome === desired.outcome &&
    stored.publication_status === desired.publication_status &&
    sameTextList(stored.aliases, desired.aliases) &&
    sameTimestamp(stored.reviewed_at, desired.reviewed_at) &&
    canonicalJson(stored.canonical_identity) === canonicalJson(desired.canonical_identity) &&
    canonicalJson(stored.portion_units) === canonicalJson(desired.portion_units) &&
    canonicalJson(stored.identity_evidence) === canonicalJson(desired.identity_evidence) &&
    canonicalJson(stored.checks) === canonicalJson(desired.checks) &&
    canonicalJson(stored.llm_review) === canonicalJson(desired.llm_review) &&
    canonicalJson(stored.source_versions) === canonicalJson(desired.source_versions) &&
    canonicalJson(stored.history) === canonicalJson(desired.history);

// ---------------------------------------------------------------------------
// Streaming the release.
//
// `validation-records.jsonl` is 50 MB across 11,046 rows, so no member is ever
// read into memory: each is streamed line by line, twice — once to verify it
// and once to apply it — and the only thing held between the two passes is the
// food key order, which is 11,046 strings.
// ---------------------------------------------------------------------------

/** What one streaming pass measured, and what manifest.json is compared against. */
export interface MemberVerification {
    readonly file: string;
    readonly sha256: string;
    readonly bytes: number;
    readonly rowCount: number;
}

const openReadStream = (absolutePath: string, file: string): fs.ReadStream => {
    try {
        return fs.createReadStream(absolutePath);
    } catch (error) {
        throw new CatalogLoadError('release_file_unreadable', `${file} could not be opened: ${safeError(error).message}`, {
            file,
        });
    }
};

/**
 * What a member's FILE was when verification measured it, as cheaply as the
 * filesystem can state it.
 *
 * It is not a substitute for the digest and is not treated as one — it is the
 * check that can run before a write, and its whole job is to make the common
 * case of a release changing between the two reads (a member regenerated,
 * replaced or truncated) refuse with nothing written at all. `mtimeNs` and
 * `ino` are kept as decimal strings because `bigint` stats are the only way to
 * get nanosecond resolution, and a same-length rewrite inside one millisecond
 * is exactly the case a millisecond-resolution timestamp would miss.
 */
interface MemberIdentity {
    readonly file: string;
    readonly bytes: number;
    readonly mtimeNs: string;
    readonly ino: string;
}

const measureMemberIdentity = (absolutePath: string, file: string): MemberIdentity => {
    try {
        const stat = fs.statSync(absolutePath, { bigint: true });
        return {
            file,
            bytes: Number(stat.size),
            mtimeNs: stat.mtimeNs.toString(),
            ino: stat.ino.toString(),
        };
    } catch (error) {
        throw new CatalogLoadError(
            'release_file_unreadable',
            `${file} could not be inspected: ${safeError(error).message}`,
            { file },
        );
    }
};

/**
 * Refuses a member whose file is no longer the one verification measured.
 *
 * Called at two points, for two different guarantees: once before retirement,
 * so a release that changed under the run costs no write at all, and again as
 * each member is opened, so the refusal is bound to the very stream the apply
 * pass is about to read.
 */
const assertMemberUnchanged = (absolutePath: string, expected: MemberIdentity): void => {
    const observed = measureMemberIdentity(absolutePath, expected.file);
    const fields: readonly (keyof MemberIdentity)[] = ['bytes', 'mtimeNs', 'ino'];

    for (const field of fields) {
        if (observed[field] === expected[field]) {
            continue;
        }
        throw new CatalogLoadError(
            'release_file_changed_during_load',
            `${expected.file} changed after it was verified: its ${field} was ${expected[field]} when the release ` +
                `was checked against manifest.json and is ${observed[field]} now. The release on disk is not the ` +
                'one that was reviewed; nothing further has been written and the active release pointer has not moved.',
            { file: expected.file, expected: expected[field], observed: observed[field] },
        );
    }
};

const parseReleaseLine = (text: string, file: string, line: number): ReleaseRow => {
    let parsed: unknown;
    try {
        parsed = JSON.parse(text) as unknown;
    } catch (error) {
        throw new CatalogLoadError(
            'release_line_invalid_json',
            `${file} line ${line} is not valid JSON: ${safeError(error).message}`,
            { file, line },
        );
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new CatalogLoadError('release_line_invalid_json', `${file} line ${line} is not a JSON object`, {
            file,
            line,
        });
    }
    return parsed as ReleaseRow;
};

/**
 * Measures one member and hands every row to `onRow`.
 *
 * The digest is taken from a `data` listener on the SAME read stream `readline`
 * consumes, so it covers the file exactly as it is on disk — including the
 * trailing newline `readline` drops — rather than from a second read that could
 * disagree with the rows just parsed.
 */
const streamMember = async (
    absolutePath: string,
    file: string,
    onRow?: (row: ReleaseRow, line: number) => void,
): Promise<MemberVerification> => {
    const hash = crypto.createHash('sha256');
    let bytes = 0;
    let rowCount = 0;

    const stream = openReadStream(absolutePath, file);
    stream.on('data', (chunk: string | Buffer) => {
        const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
        hash.update(buffer);
        bytes += buffer.length;
    });

    const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
    try {
        let lineNumber = 0;
        for await (const text of lines) {
            lineNumber += 1;
            if (text.length === 0) {
                continue;
            }
            rowCount += 1;
            if (onRow !== undefined) {
                onRow(parseReleaseLine(text, file, lineNumber), lineNumber);
            }
        }
    } finally {
        lines.close();
        stream.destroy();
    }

    return { file, sha256: hash.digest('hex'), bytes, rowCount };
};

/**
 * One member, readable one row at a time with a single row of lookahead.
 *
 * The apply pass walks the foods and their four child members together, which
 * needs exactly this much: "is the next child row still this food's?" is
 * answered by `peek`, and only then is it consumed. It is the alternative to
 * indexing the children by parent in memory, which for the real release would
 * mean holding 50 MB of validation records and 31,899 portions at once.
 */
interface MemberCursor {
    peek(): Promise<{ row: ReleaseRow; line: number } | null>;
    take(): Promise<{ row: ReleaseRow; line: number } | null>;
    /**
     * The digest, byte length and row count of the bytes THIS cursor read.
     *
     * `complete` is false until the stream has ended, and the comparison
     * against manifest.json refuses in that case rather than trusting a partial
     * measurement: a half-read member cannot be bound to what was verified.
     */
    measured(): AppliedMeasurement;
    close(): void;
}

/** One apply-pass measurement, with whether the member was read to its end. */
interface AppliedMeasurement extends MemberVerification {
    readonly complete: boolean;
}

const openMemberCursor = (absolutePath: string, file: string, identity: MemberIdentity): MemberCursor => {
    // AT OPEN, BEFORE A SINGLE BYTE IS READ: the file the apply pass is about to
    // stream must still be the file verification measured (see THE TWO READS).
    assertMemberUnchanged(absolutePath, identity);

    const stream = openReadStream(absolutePath, file);
    // The same `data`-listener trick `streamMember` uses, for the same reason
    // and now for the bytes that are actually APPLIED: the digest is taken from
    // the stream `readline` consumes, so it covers the file exactly as this pass
    // read it — trailing newline included — rather than from a third read that
    // could disagree with the rows just written.
    const hash = crypto.createHash('sha256');
    let bytes = 0;
    let rowCount = 0;
    let ended = false;
    stream.on('data', (chunk: string | Buffer) => {
        const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
        hash.update(buffer);
        bytes += buffer.length;
    });
    stream.on('end', () => {
        ended = true;
    });

    const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
    const iterator = lines[Symbol.asyncIterator]();

    let lineNumber = 0;
    let lookahead: { row: ReleaseRow; line: number } | null = null;
    let exhausted = false;

    const advance = async (): Promise<{ row: ReleaseRow; line: number } | null> => {
        for (;;) {
            const next = await iterator.next();
            if (next.done === true) {
                exhausted = true;
                return null;
            }
            lineNumber += 1;
            if (next.value.length === 0) {
                continue;
            }
            rowCount += 1;
            return { row: parseReleaseLine(next.value, file, lineNumber), line: lineNumber };
        }
    };

    const peek = async (): Promise<{ row: ReleaseRow; line: number } | null> => {
        if (lookahead === null && !exhausted) {
            lookahead = await advance();
        }
        return lookahead;
    };

    return {
        peek,
        take: async (): Promise<{ row: ReleaseRow; line: number } | null> => {
            const row = await peek();
            lookahead = null;
            return row;
        },
        measured: (): AppliedMeasurement => ({
            file,
            sha256: hash.copy().digest('hex'),
            bytes,
            rowCount,
            // A zero-length member emits no `data` and, on some kernels, is
            // closed rather than ended, so an exhausted iterator over no bytes
            // is as complete as an `end` event.
            complete: ended || (exhausted && bytes === 0),
        }),
        close: (): void => {
            lines.close();
            stream.destroy();
        },
    };
};

/** What the verification pass establishes before anything is written. */
interface ReleaseVerification {
    readonly members: readonly MemberVerification[];
    /** Every food's `source_key` mapped to its position in `foods.jsonl`. */
    readonly foodOrder: ReadonlyMap<string, number>;
    readonly foodsSha256: string;
    /**
     * What each member's file was at the moment it was measured, by member
     * name. The apply pass compares it before it writes and again as it opens
     * each member — see THE TWO READS in this file's header.
     */
    readonly identities: ReadonlyMap<string, MemberIdentity>;
}

/**
 * How much of a digest a message or a log line shows.
 *
 * scripts/lib/logger.ts's last scrub rule redacts any long opaque run, which
 * includes a full SHA-256, and that rule is not to be widened — so a checksum
 * is reported as a prefix, exactly as that module instructs. The FULL digests
 * stay on the error's `context`, where a programmatic caller reads them and no
 * redaction applies.
 */
const DIGEST_DISPLAY_CHARS = 12;

const forDisplay = (value: number | string): string =>
    typeof value === 'string' && value.length > DIGEST_DISPLAY_CHARS
        ? `${value.slice(0, DIGEST_DISPLAY_CHARS)}…`
        : String(value);

const compareMeasurement = (
    file: string,
    what: 'digest' | 'size' | 'row count',
    code: CatalogLoadErrorCode,
    expected: number | string,
    observed: number | string,
): void => {
    if (expected === observed) {
        return;
    }
    throw new CatalogLoadError(
        code,
        `${file}: the manifest declares a ${what} of ${forDisplay(expected)} and the file on disk measures ` +
            `${forDisplay(observed)}. The release is not the one that was reviewed; nothing has been written.`,
        { file, expected, observed },
    );
};

/**
 * VERIFY BEFORE WRITE. Every member the manifest lists is streamed and compared
 * against it — digest, byte length and row count — and `foods.jsonl` is
 * additionally read for its key order, its uniqueness and its published count.
 *
 * Nothing in here touches the database, which is the property that makes a
 * tampered release harmless: the refusal happens before a run row exists.
 */
const verifyRelease = async (deps: LoadDeps): Promise<ReleaseVerification> => {
    const { manifest, logger } = deps;
    // Guarded rather than trusted for the same reason preflight guards it: the
    // manifest is a document on disk, so its declared type does not bind what
    // arrives — and a direct caller of `runLoad` may not have run preflight.
    const listed = Array.isArray(manifest.files) ? manifest.files : [];
    const declared = new Map(listed.map((file) => [file.path, file]));
    const members: MemberVerification[] = [];
    const identities = new Map<string, MemberIdentity>();
    const foodOrder = new Map<string, number>();
    let publishedLines = 0;

    for (const member of RELEASE_MEMBERS) {
        const entry = declared.get(member.file);
        if (entry === undefined) {
            // Refused as a prerequisite gap by main()'s preflight, so this path
            // belongs to a caller that verified nothing first; kept as the
            // guarantee itself, because a member with no declared digest cannot
            // be verified and must never be loaded unverified.
            throw new CatalogLoadError(
                'release_member_not_listed',
                `${describeReleaseFile(deps.release, 'manifest.json')} does not list ${member.file}, so it cannot be verified`,
                { file: member.file },
            );
        }

        const absolutePath = path.join(deps.releaseRoot, member.file);
        const measured =
            member.file === FOODS_FILE
                ? await streamMember(absolutePath, member.file, (row, line) => {
                      const sourceKey = readText(row, 'source_key', FOODS_FILE, line);
                      if (foodOrder.has(sourceKey)) {
                          throw new CatalogLoadError(
                              'release_duplicate_food',
                              `${FOODS_FILE} line ${line} repeats source_key "${sourceKey}", which is the release's stable identity`,
                              { file: FOODS_FILE, line, sourceKey },
                          );
                      }
                      foodOrder.set(sourceKey, foodOrder.size);
                      if (readText(row, 'publication_status', FOODS_FILE, line) === PUBLISHED) {
                          publishedLines += 1;
                      }
                  })
                : await streamMember(absolutePath, member.file);

        compareMeasurement(member.file, 'digest', 'release_file_digest_mismatch', entry.sha256, measured.sha256);
        compareMeasurement(member.file, 'size', 'release_file_size_mismatch', entry.bytes, measured.bytes);
        compareMeasurement(
            member.file,
            'row count',
            'release_file_row_count_mismatch',
            entry.row_count,
            measured.rowCount,
        );

        // Taken AFTER the digest, and required to agree with the bytes just
        // hashed: a size that already disagrees means the file moved under the
        // verification itself, which no later comparison could attribute.
        const identity = measureMemberIdentity(absolutePath, member.file);
        if (identity.bytes !== measured.bytes) {
            throw new CatalogLoadError(
                'release_file_changed_during_load',
                `${member.file} changed while it was being verified: ${measured.bytes} byte(s) were read and the ` +
                    `file now measures ${identity.bytes}. Nothing has been written.`,
                { file: member.file, expected: measured.bytes, observed: identity.bytes },
            );
        }
        identities.set(member.file, identity);

        members.push(measured);
        logger.info('release_file_verified', {
            stage: STAGE,
            file: member.file,
            sha256: forDisplay(measured.sha256),
            bytes: measured.bytes,
            rows: measured.rowCount,
        });
    }

    // A release exports the published set and nothing else, so every line must
    // state it. The published count after the load is compared against the
    // manifest, so a release carrying an unpublished line could only ever fail
    // that comparison — and failing it here, with nothing written, is the
    // difference between a refusal an operator can read and a load that rolls
    // no rows back.
    const expectedPublished = manifest.counts.published_foods ?? manifest.counts.foods;
    if (publishedLines !== expectedPublished) {
        throw new CatalogLoadError(
            'release_published_count_mismatch',
            `${FOODS_FILE} states ${publishedLines} published food(s) and the manifest declares ${expectedPublished}. ` +
                'A release carries the published set only; nothing has been written.',
            { file: FOODS_FILE, expected: expectedPublished, observed: publishedLines },
        );
    }

    const foods = members.find((member) => member.file === FOODS_FILE);

    return {
        members,
        foodOrder,
        // Non-null by construction: FOODS_FILE is the first member verified, so
        // reaching here means it measured.
        foodsSha256: foods === undefined ? '' : foods.sha256,
        identities,
    };
};

/**
 * Refuses a release whose files are no longer the ones verification measured,
 * before the load writes anything at all.
 *
 * It runs ahead of retirement — the first write of the load — so that the
 * ordinary way a release changes between the two reads (a member regenerated or
 * replaced by a second operator, or a partially written copy) costs no row
 * write and no retirement. The digest comparison in `verifyAppliedMembers` is
 * the guarantee; this is the courtesy that makes the guarantee cheap.
 */
const assertReleaseUnchanged = (deps: LoadDeps, verification: ReleaseVerification): void => {
    for (const member of RELEASE_MEMBERS) {
        const identity = verification.identities.get(member.file);
        if (identity === undefined) {
            throw new CatalogLoadError(
                'release_member_not_listed',
                `${member.file} was not measured by the verification pass, so the bytes about to be applied cannot ` +
                    'be bound to the release that was reviewed',
                { file: member.file },
            );
        }
        assertMemberUnchanged(path.join(deps.releaseRoot, member.file), identity);
    }
};

// ---------------------------------------------------------------------------
// The database.
//
// A narrow STRUCTURAL slice of the Prisma client, declared here so this file
// never depends on the generated client's shape beyond the six models it
// touches, and so the suite under src/__tests__/scripts can drive `runLoad`
// through the real client or through its own. `catalog_import_runs` is
// deliberately absent: checkpoint.ts owns that table and takes its own `db`.
//
// WHY THESE WRITES CARRY NO OWNER PREDICATE. Rule backend-architecture §5.1
// requires `user_id` in every `where`, including updates and deletes. The six
// catalog tables are the sanctioned exception, and prisma/schema.prisma and AAP
// §0.5.1 both say so at the model: they hold SHARED REFERENCE DATA, carry no
// `user_id` by design, and adding an owner column to them would be a mistake
// rather than a fix. There is no tenant to scope to and no request-scoped
// identity ever reaches this file — it runs only from an operator CLI. The
// compensating control is scripts/lib/dbGuard.ts, which classifies
// `DATABASE_URL` before any client exists and demands `--confirm-target` for a
// non-development origin: the guard decides WHICH DATABASE may be written, and
// `source_key` decides which row.
// ---------------------------------------------------------------------------

export interface LoadDb {
    catalog_foods: {
        /** The rows are shaped by the `select` at each call site, so each one casts. */
        findMany(args: unknown): Promise<readonly unknown[]>;
        findUnique(args: unknown): Promise<unknown>;
        create(args: unknown): Promise<{ id: string }>;
        update(args: unknown): Promise<{ id: string }>;
        updateMany(args: unknown): Promise<{ count: number }>;
        count(args?: unknown): Promise<number>;
    };
    catalog_food_aliases: {
        deleteMany(args: unknown): Promise<{ count: number }>;
        createMany(args: unknown): Promise<{ count: number }>;
        count(args?: unknown): Promise<number>;
    };
    catalog_food_portions: {
        deleteMany(args: unknown): Promise<{ count: number }>;
        create(args: unknown): Promise<{ id: string }>;
        update(args: unknown): Promise<{ id: string }>;
        count(args?: unknown): Promise<number>;
    };
    catalog_food_components: {
        deleteMany(args: unknown): Promise<{ count: number }>;
        upsert(args: unknown): Promise<{ id: string }>;
        count(args?: unknown): Promise<number>;
    };
    catalog_validation_records: {
        upsert(args: unknown): Promise<{ id: string }>;
        count(args?: unknown): Promise<number>;
    };
    catalog_generation_batches: {
        findMany(args: unknown): Promise<readonly unknown[]>;
    };
    $transaction<T>(work: (tx: LoadDb) => Promise<T>, options?: { timeout?: number }): Promise<T>;
}

/** One `catalog_foods` row as this file reads it: its id and every column a release states. */
interface StoredFoodRow extends FoodColumns {
    readonly id: string;
}

interface StoredValidationRow {
    readonly id: string;
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
}

interface StoredFoodWithChildren extends StoredFoodRow {
    readonly catalog_food_aliases: readonly { readonly id: string; readonly alias: string }[];
    readonly catalog_food_portions: readonly ({ readonly id: string } & PortionColumns)[];
    readonly catalog_food_components: readonly {
        readonly id: string;
        readonly component_catalog_food_id: string;
        readonly quantity_grams: number;
        readonly yield_factor: number;
        readonly component_nutrition_version: number;
        readonly sort_order: number;
        readonly component_catalog_foods: { readonly source_key: string };
    }[];
    readonly catalog_validation_records: StoredValidationRow | null;
}

/** Exactly the columns a release states, so nothing else is ever read or compared. */
const FOOD_COLUMN_SELECT: Readonly<Record<string, true>> = {
    id: true,
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
    generation_batch_id: true,
    search_text: true,
    imported_at: true,
};

const FOOD_WITH_CHILDREN_SELECT: Readonly<Record<string, unknown>> = {
    ...FOOD_COLUMN_SELECT,
    catalog_food_aliases: { select: { id: true, alias: true } },
    catalog_food_portions: {
        select: {
            id: true,
            description: true,
            amount: true,
            unit: true,
            gram_weight: true,
            is_default: true,
            source: true,
        },
    },
    catalog_food_components: {
        select: {
            id: true,
            component_catalog_food_id: true,
            quantity_grams: true,
            yield_factor: true,
            component_nutrition_version: true,
            sort_order: true,
            component_catalog_foods: { select: { source_key: true } },
        },
    },
    catalog_validation_records: {
        select: {
            id: true,
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

// ---------------------------------------------------------------------------
// The run.
// ---------------------------------------------------------------------------

/**
 * The checkpoint this stage resumes from.
 *
 * `foodsSha256` is what makes a stale cursor DETECTABLE rather than dangerous:
 * a cursor names a position in a file, so a cursor kept across a changed
 * release would resume into the wrong place. A digest that no longer matches
 * the file on disk is therefore ignored and the load starts over — which is
 * safe precisely because the reconciliation is idempotent.
 *
 * `verifiedFiles` records that every member was verified for this attempt.
 * Verification is never SKIPPED on a resume — the files could have changed
 * while the run was interrupted, and a resumed run that trusted a previous
 * attempt's verification would be loading unverified bytes.
 */
export interface LoadCursor {
    readonly releaseId: string;
    readonly foodsSha256: string;
    readonly verifiedFiles: readonly string[];
    /**
     * A WATERMARK over settled foods, or `null` before the first one settles.
     *
     * What it guarantees is the whole of the resume contract: every food up to
     * and including this key has been SETTLED — its row, aliases, portions,
     * compositions and validation record all committed in one transaction, or
     * found already equal to the release — so a run resuming after it cannot
     * skip unfinished work. It therefore stops advancing the moment a food is
     * deferred (`applyFood`), freezing at the last settled key until the
     * deferred pass has drained, at which point it advances to the last food
     * processed. A resumed run re-reads the deferred food and everything after
     * it, which costs nothing: re-reconciling a settled food writes nothing.
     */
    readonly lastSourceKey: string | null;
}

/** Every outcome the load counts, so a report states what actually happened. */
export interface LoadCounts {
    readonly foodsInserted: number;
    readonly foodsUpdated: number;
    readonly foodsUnchanged: number;
    /** Foods a resumed run passed over because a previous attempt settled them. */
    readonly foodsSkippedByCursor: number;
    readonly foodsRetired: number;
    /** Foods this release publishes again after a previous release retired them. */
    readonly foodsRestored: number;
    readonly aliasesWritten: number;
    readonly aliasesRemoved: number;
    readonly portionsWritten: number;
    readonly portionsRemoved: number;
    readonly componentsWritten: number;
    readonly componentsRemoved: number;
    /**
     * Foods this run could not write in file order because a composition named
     * a food the release carries but had not loaded yet, and which the deferred
     * pass applied instead — see `applyFood` and `applyDeferredFoods`. Nothing
     * is written for such a food until it is applied whole, and when it is it
     * counts as inserted or updated like any other.
     */
    readonly foodsDeferred: number;
    readonly validationRecordsWritten: number;
    /** Release foods naming a generation batch this database does not hold. */
    readonly generationBatchUnresolved: number;
}

type MutableLoadCounts = { -readonly [Key in keyof LoadCounts]: number };

const emptyCounts = (): MutableLoadCounts => ({
    foodsInserted: 0,
    foodsUpdated: 0,
    foodsUnchanged: 0,
    foodsSkippedByCursor: 0,
    foodsRetired: 0,
    foodsRestored: 0,
    aliasesWritten: 0,
    aliasesRemoved: 0,
    portionsWritten: 0,
    portionsRemoved: 0,
    componentsWritten: 0,
    componentsRemoved: 0,
    foodsDeferred: 0,
    validationRecordsWritten: 0,
    generationBatchUnresolved: 0,
});

/** One post-load comparison against the manifest, reported whether it passed or not. */
export interface CountCheck {
    readonly name: string;
    readonly expected: number;
    readonly observed: number;
    readonly ok: boolean;
}

export interface LoadSummary {
    /** `null` for a dry run, which deliberately opens no run row. */
    readonly runId: string | null;
    readonly release: string;
    readonly resumed: boolean;
    readonly dryRun: boolean;
    /**
     * Whether this run is now the active release — read back through
     * checkpoint.ts's `getActiveReleaseLoad` rather than assumed from the
     * close, because the pointer IS that query's answer.
     */
    readonly activated: boolean;
    readonly counts: LoadCounts;
    readonly verification: readonly MemberVerification[];
    readonly countChecks: readonly CountCheck[];
    /** Every food this run retired, so a report names them rather than counting them. */
    readonly retiredSourceKeys: readonly string[];
}

export interface LoadDeps {
    readonly db: LoadDb;
    /** checkpoint.ts's client: the run row, its cursor, its counts and the pointer. */
    readonly runDb: CatalogRunDb;
    /** The validated release id; must equal `manifest.release_id`. */
    readonly release: string;
    readonly manifest: CatalogReleaseManifest;
    /** Absolute directory holding the release's five members and its manifest. */
    readonly releaseRoot: string;
    readonly logger: ScriptLogger;
    readonly now: () => Date;
    readonly dryRun: boolean;
    /**
     * Called after each food is settled, before the next one is read.
     *
     * A progress seam, and the one the suite uses to interrupt a load after
     * partial progress: a throw from here ends the run exactly as a database
     * failure would, so the "failure after partial progress, then a successful
     * rerun" scenario (AAP §0.9.2) is exercised through this interface instead
     * of by mocking a module internal. `installRateLimiter` in
     * catalog-import-usda.ts's `RunImportDeps` is the same idea.
     */
    readonly onFoodSettled?: (event: {
        readonly sourceKey: string;
        readonly outcome: FoodOutcome;
        readonly index: number;
    }) => void | Promise<void>;
    /**
     * Called once the release has been verified against its manifest and before
     * anything is claimed, retired or written.
     *
     * The counterpart seam to `onFoodSettled`, and the only place a caller can
     * observe the boundary between the two reads this file's header describes.
     * The suite uses it to change a member between them, which is how the
     * between-passes refusal is proved without mocking a module internal.
     */
    readonly onReleaseVerified?: (event: {
        readonly members: readonly MemberVerification[];
    }) => void | Promise<void>;
}

/**
 * What became of one food.
 *
 * `onFoodSettled` reports these three and only these three: a food is settled
 * when its row and all four child sets are committed, which is why 'deferred'
 * is not one of them — see `ApplyOutcome`.
 */
export type FoodOutcome = 'inserted' | 'updated' | 'unchanged';

/**
 * What `applyFood` did, which is one more case than a food can END as:
 * 'deferred' means it wrote NOTHING and the whole food is queued for the
 * fixpoint pass, because a composition names a food this release carries and
 * has not loaded yet.
 */
type ApplyOutcome = FoodOutcome | 'deferred';

/** One food and its children as the release states them. */
interface PreparedFood {
    readonly sourceKey: string;
    readonly line: number;
    readonly index: number;
    readonly scalars: FoodScalars;
    readonly generationBatchKey: string | null;
    readonly aliases: readonly string[];
    readonly portions: readonly PortionColumns[];
    readonly components: readonly ComponentSpec[];
    readonly validation: ValidationColumns;
}

interface LoadState {
    readonly counts: MutableLoadCounts;
    /** What `recordCounts` has already been told, so the next delta is the delta. */
    readonly recorded: MutableLoadCounts;
    /** Local `catalog_foods.id` by `source_key`: ids never move, so this never goes stale. */
    readonly localIdBySourceKey: Map<string, string>;
    /** Resolved `catalog_generation_batches.id` by portable batch key; `null` means "looked up, absent". */
    readonly batchIdByKey: Map<string, string | null>;
    /**
     * Foods nothing has been written for yet, whole, in the order the release
     * states them — see `applyFood` and `applyDeferredFoods`.
     */
    readonly deferred: PreparedFood[];
    /** The persisted watermark; see `LoadCursor.lastSourceKey`. */
    lastSourceKey: string | null;
    /**
     * The last food read from `foods.jsonl` in this attempt, settled or not.
     * The watermark catches up to it once the deferred queue drains.
     */
    lastProcessedKey: string | null;
}

/**
 * How many foods are prepared, prefetched and compared before their
 * transactions run. 250 keeps one chunk's validation records — the heaviest
 * rows in the release at ~4.6 kB each — around a megabyte, and makes the
 * cursor and count checkpoints frequent enough that an interrupted load
 * repeats at most that many foods.
 */
const CHUNK_SIZE = 250;

/** `IN (…)` list size for the retirement update; the absent set is usually far smaller. */
const RETIRE_CHUNK_SIZE = 500;

/** 30 s: one food is at most ~10 statements, well inside it, but a cold pool is not. */
const TRANSACTION_TIMEOUT_MS = 30_000;

const chunked = <T>(values: readonly T[], size: number): T[][] => {
    const chunks: T[][] = [];
    for (let index = 0; index < values.length; index += size) {
        chunks.push(values.slice(index, index + size));
    }
    return chunks;
};

// ---------------------------------------------------------------------------
// Reading a food and its children together.
//
// The five members are walked in lockstep rather than indexed in memory, which
// is what keeps the pass over a 50 MB member bounded. It relies on one property
// of the artefact, which catalog-release.ts guarantees and which this pass
// CHECKS rather than assumes: each child member is grouped by
// `food_source_key`, and its groups appear in the order `foods.jsonl` states.
// A child whose food the release does not carry, or whose group arrives after
// its food has been passed, is refused by name.
// ---------------------------------------------------------------------------

const takeChildRows = async (
    cursor: MemberCursor,
    file: string,
    food: { readonly sourceKey: string; readonly index: number },
    foodOrder: ReadonlyMap<string, number>,
): Promise<{ row: ReleaseRow; line: number }[]> => {
    const rows: { row: ReleaseRow; line: number }[] = [];

    for (;;) {
        const head = await cursor.peek();
        if (head === null) {
            return rows;
        }

        const parentKey = readText(head.row, 'food_source_key', file, head.line);
        const parentIndex = foodOrder.get(parentKey);

        if (parentIndex === undefined) {
            throw new CatalogLoadError(
                'release_child_without_food',
                `${file} line ${head.line} belongs to food "${parentKey}", which ${FOODS_FILE} does not carry`,
                { file, line: head.line, sourceKey: parentKey },
            );
        }
        if (parentIndex < food.index) {
            throw new CatalogLoadError(
                'release_member_out_of_order',
                `${file} line ${head.line} belongs to food "${parentKey}", which ${FOODS_FILE} lists before ` +
                    `"${food.sourceKey}": every child member must be grouped by food in the order ${FOODS_FILE} states`,
                { file, line: head.line, sourceKey: parentKey },
            );
        }
        if (parentIndex > food.index) {
            return rows;
        }

        const taken = await cursor.take();
        if (taken !== null) {
            rows.push(taken);
        }
    }
};

const duplicateChild = (file: string, line: number, sourceKey: string, what: string): CatalogLoadError =>
    new CatalogLoadError(
        'release_duplicate_child',
        `${file} line ${line} repeats ${what} for food "${sourceKey}", which the database holds at most once per food`,
        { file, line, sourceKey },
    );

/** The five members' cursors, opened together and closed together. */
interface ReleaseCursors {
    readonly foods: MemberCursor;
    readonly aliases: MemberCursor;
    readonly portions: MemberCursor;
    readonly components: MemberCursor;
    readonly validation: MemberCursor;
}

/**
 * Each member's cursor paired with its name, so a step that has to treat the
 * five uniformly — closing them, measuring them — states the pairing once.
 */
const memberCursors = (
    cursors: ReleaseCursors,
): readonly { readonly file: string; readonly cursor: MemberCursor }[] => [
    { file: FOODS_FILE, cursor: cursors.foods },
    { file: ALIASES_FILE, cursor: cursors.aliases },
    { file: PORTIONS_FILE, cursor: cursors.portions },
    { file: COMPONENTS_FILE, cursor: cursors.components },
    { file: VALIDATION_RECORDS_FILE, cursor: cursors.validation },
];

/**
 * Opens the five members for the apply pass, each against the file identity
 * verification measured (see THE TWO READS in this file's header).
 *
 * A member already open when a later one is refused is closed here rather than
 * leaked: the refusal happens before any row is written, so the only thing to
 * clean up is the file handle.
 */
const openReleaseCursors = (releaseRoot: string, verification: ReleaseVerification): ReleaseCursors => {
    const opened: MemberCursor[] = [];

    const open = (file: string): MemberCursor => {
        const identity = verification.identities.get(file);
        if (identity === undefined) {
            throw new CatalogLoadError(
                'release_member_not_listed',
                `${file} was not measured by the verification pass, so it must not be applied unverified`,
                { file },
            );
        }
        const cursor = openMemberCursor(path.join(releaseRoot, file), file, identity);
        opened.push(cursor);
        return cursor;
    };

    try {
        return {
            foods: open(FOODS_FILE),
            aliases: open(ALIASES_FILE),
            portions: open(PORTIONS_FILE),
            components: open(COMPONENTS_FILE),
            validation: open(VALIDATION_RECORDS_FILE),
        };
    } catch (error) {
        for (const cursor of opened) {
            cursor.close();
        }
        throw error;
    }
};

const closeReleaseCursors = (cursors: ReleaseCursors): void => {
    for (const member of memberCursors(cursors)) {
        member.cursor.close();
    }
};

/**
 * The next food, with the aliases, portions, components and validation record
 * the release states for it. `null` once `foods.jsonl` is exhausted.
 */
const readPreparedFood = async (
    cursors: ReleaseCursors,
    foodOrder: ReadonlyMap<string, number>,
    index: number,
): Promise<PreparedFood | null> => {
    const head = await cursors.foods.take();
    if (head === null) {
        return null;
    }

    const { scalars, generationBatchKey } = parseFoodLine(head.row, head.line);
    const food = { sourceKey: scalars.source_key, index };

    const aliasSeen = new Set<string>();
    const aliases: string[] = [];
    for (const entry of await takeChildRows(cursors.aliases, ALIASES_FILE, food, foodOrder)) {
        const alias = readText(entry.row, 'alias', ALIASES_FILE, entry.line);
        if (aliasSeen.has(alias)) {
            throw duplicateChild(ALIASES_FILE, entry.line, food.sourceKey, `alias "${alias}"`);
        }
        aliasSeen.add(alias);
        aliases.push(alias);
    }

    const portionSeen = new Set<string>();
    const portions: PortionColumns[] = [];
    for (const entry of await takeChildRows(cursors.portions, PORTIONS_FILE, food, foodOrder)) {
        const portion = parsePortionLine(entry.row, entry.line);
        if (portionSeen.has(portion.description)) {
            throw duplicateChild(PORTIONS_FILE, entry.line, food.sourceKey, `portion "${portion.description}"`);
        }
        portionSeen.add(portion.description);
        portions.push(portion);
    }

    const componentSeen = new Set<string>();
    const components: ComponentSpec[] = [];
    for (const entry of await takeChildRows(cursors.components, COMPONENTS_FILE, food, foodOrder)) {
        const component = parseComponentLine(entry.row, entry.line);
        if (componentSeen.has(component.componentSourceKey)) {
            throw duplicateChild(
                COMPONENTS_FILE,
                entry.line,
                food.sourceKey,
                `component "${component.componentSourceKey}"`,
            );
        }
        componentSeen.add(component.componentSourceKey);
        components.push(component);
    }

    const validationRows = await takeChildRows(cursors.validation, VALIDATION_RECORDS_FILE, food, foodOrder);
    if (validationRows.length > 1) {
        throw new CatalogLoadError(
            'release_duplicate_validation_record',
            `${VALIDATION_RECORDS_FILE} carries ${validationRows.length} records for food "${food.sourceKey}"; ` +
                'the column is unique per food',
            { file: VALIDATION_RECORDS_FILE, line: validationRows[1].line, sourceKey: food.sourceKey },
        );
    }
    if (validationRows.length === 0) {
        // AAP §0.1.1: every published item carries a machine-readable validation
        // record, and catalog-release.ts refuses to export a published food
        // without one. Loading the food anyway would publish an unevidenced row.
        throw new CatalogLoadError(
            'release_validation_record_missing',
            `${VALIDATION_RECORDS_FILE} carries no record for food "${food.sourceKey}", so loading it would publish ` +
                'a row with no validation evidence. Run "npm run catalog:validate" and reproduce the release.',
            { file: VALIDATION_RECORDS_FILE, sourceKey: food.sourceKey },
        );
    }

    return {
        sourceKey: food.sourceKey,
        line: head.line,
        index,
        scalars,
        generationBatchKey,
        aliases,
        portions,
        components,
        validation: parseValidationLine(validationRows[0].row, validationRows[0].line),
    };
};

/**
 * Nothing may be left over once every food has been read: a remaining child row
 * either belongs to no food in the release or to one already passed, and both
 * are the same defect seen from the end of the file.
 */
const assertMembersExhausted = async (
    cursors: ReleaseCursors,
    foodOrder: ReadonlyMap<string, number>,
): Promise<void> => {
    const remaining: readonly { readonly cursor: MemberCursor; readonly file: string }[] = [
        { cursor: cursors.aliases, file: ALIASES_FILE },
        { cursor: cursors.portions, file: PORTIONS_FILE },
        { cursor: cursors.components, file: COMPONENTS_FILE },
        { cursor: cursors.validation, file: VALIDATION_RECORDS_FILE },
    ];

    for (const member of remaining) {
        const head = await member.cursor.peek();
        if (head === null) {
            continue;
        }
        const parentKey = readText(head.row, 'food_source_key', member.file, head.line);
        throw foodOrder.has(parentKey)
            ? new CatalogLoadError(
                  'release_member_out_of_order',
                  `${member.file} line ${head.line} belongs to food "${parentKey}", which ${FOODS_FILE} lists ` +
                      'earlier: every child member must be grouped by food in the order ' +
                      `${FOODS_FILE} states`,
                  { file: member.file, line: head.line, sourceKey: parentKey },
              )
            : new CatalogLoadError(
                  'release_child_without_food',
                  `${member.file} line ${head.line} belongs to food "${parentKey}", which ${FOODS_FILE} does not carry`,
                  { file: member.file, line: head.line, sourceKey: parentKey },
              );
    }
};

/**
 * Compares what the APPLY pass read against what the verification pass
 * measured, member by member.
 *
 * Each `verification.members` entry was already proved equal to manifest.json's
 * declaration, so agreeing with it is agreeing with the reviewed release. This
 * is what binds the rows this run wrote to the bytes a human reviewed: it runs
 * before the counts are verified and therefore before the run can be closed
 * 'succeeded', so a member that changed between the two reads closes the run
 * 'failed' and the active release pointer never moves onto it.
 *
 * WHY THE RELEASE IS NOT SPOOLED INTO VERIFIED COPIES. Copying each member to a
 * temporary file during verification and applying the copy would make the two
 * reads the same bytes by construction, and it was weighed and rejected: it
 * would copy ~70 MB per load and give an operator command a temp-file lifecycle
 * to own (disk, cleanup, a half-written spool after a kill), while the property
 * that matters — rows that disagree with the manifest can never become the
 * active release — is exactly what this comparison delivers under the failure
 * model this file already has (run 'failed', pointer unmoved, rerun repairs).
 */
const verifyAppliedMembers = (
    deps: LoadDeps,
    cursors: ReleaseCursors,
    verification: ReleaseVerification,
): void => {
    const applied = new Map(memberCursors(cursors).map((entry) => [entry.file, entry.cursor.measured()]));

    for (const member of verification.members) {
        const measured = applied.get(member.file);
        if (measured === undefined || !measured.complete) {
            throw new CatalogLoadError(
                'release_file_changed_during_load',
                `${member.file} was not read to its end by the load, so the rows it applied cannot be bound to the ` +
                    'verified release. The run is recorded as failed and the active release pointer has not moved.',
                { file: member.file, expected: member.bytes, observed: measured === undefined ? 0 : measured.bytes },
            );
        }

        const mismatch = [
            { what: 'digest', expected: member.sha256 as number | string, observed: measured.sha256 as number | string },
            { what: 'byte length', expected: member.bytes as number | string, observed: measured.bytes as number | string },
            { what: 'row count', expected: member.rowCount as number | string, observed: measured.rowCount as number | string },
        ].filter((comparison) => comparison.expected !== comparison.observed);

        if (mismatch.length > 0) {
            throw new CatalogLoadError(
                'release_file_changed_during_load',
                `${member.file} changed between its verification and the load: the verified ${mismatch[0].what} is ` +
                    `${forDisplay(mismatch[0].expected)} and the bytes this load read measure ` +
                    `${forDisplay(mismatch[0].observed)}. Rows that were never reviewed must not become the active ` +
                    'release, so the run is recorded as failed, the pointer has not moved, and rerunning the load ' +
                    'over a correct release repairs it.',
                { file: member.file, expected: mismatch[0].expected, observed: mismatch[0].observed },
            );
        }

        deps.logger.info('applied_bytes_verified', {
            stage: STAGE,
            release: deps.release,
            file: member.file,
            sha256: forDisplay(measured.sha256),
            bytes: measured.bytes,
            rows: measured.rowCount,
        });
    }
};

// ---------------------------------------------------------------------------
// Applying one food.
// ---------------------------------------------------------------------------

const readFoodWithChildren = async (db: LoadDb, sourceKey: string): Promise<StoredFoodWithChildren | null> => {
    const row = await db.catalog_foods.findUnique({
        where: { source_key: sourceKey },
        select: FOOD_WITH_CHILDREN_SELECT,
    });

    // The cast names the `select` immediately above it. Unlike a release line —
    // which is external input and is READ field by field — this is the shape of
    // this file's own query, so asserting it is a statement about the query and
    // not a claim about untrusted data.
    return row === null || row === undefined ? null : (row as StoredFoodWithChildren);
};

const prefetchFoods = async (
    db: LoadDb,
    sourceKeys: readonly string[],
): Promise<Map<string, StoredFoodWithChildren>> => {
    if (sourceKeys.length === 0) {
        return new Map();
    }

    const rows = (await db.catalog_foods.findMany({
        where: { source_key: { in: [...sourceKeys] } },
        select: FOOD_WITH_CHILDREN_SELECT,
    })) as readonly StoredFoodWithChildren[];

    return new Map(rows.map((row) => [row.source_key, row]));
};

/**
 * Resolves the portable `generation_batch_key` a release food may carry against
 * `catalog_generation_batches.batch_key`.
 *
 * WHY AN UNRESOLVED KEY IS A FACT AND NOT A REFUSAL. A release ships no batches
 * member — the batch ledger is a local audit trail of model calls this database
 * paid for, and its ids mean nothing elsewhere — so an AI-bearing release
 * loaded into a database that never ran the generation stage carries keys that
 * cannot resolve anywhere. Refusing would make such a release unloadable, and
 * inventing a batch row would fabricate a spend record. The link is therefore
 * left null and the fact is counted and logged, which is recoverable: the food's
 * own identity, nutrition and provenance are all in the release, and
 * `generation_batch_id` is `SetNull` in the schema precisely because it is a
 * reference to local history rather than part of the food.
 */
const resolveGenerationBatches = async (
    deps: LoadDeps,
    keys: readonly string[],
    state: LoadState,
): Promise<void> => {
    const unknown = [...new Set(keys)].filter((key) => !state.batchIdByKey.has(key));
    if (unknown.length === 0) {
        return;
    }

    const rows = (await deps.db.catalog_generation_batches.findMany({
        where: { batch_key: { in: unknown } },
        select: { id: true, batch_key: true },
    })) as readonly { readonly id: string; readonly batch_key: string }[];

    const found = new Map(rows.map((row) => [row.batch_key, row.id]));
    for (const key of unknown) {
        const id = found.get(key) ?? null;
        state.batchIdByKey.set(key, id);
        if (id === null) {
            state.counts.generationBatchUnresolved += 1;
            deps.logger.warn('generation_batch_unresolved', {
                stage: STAGE,
                release: deps.release,
                batchKey: key,
                note: 'the food is loaded with generation_batch_id null; a release ships no batch ledger',
            });
        }
    }
};

const sameAliases = (stored: StoredFoodWithChildren, desired: readonly string[]): boolean => {
    if (stored.catalog_food_aliases.length !== desired.length) {
        return false;
    }
    const held = new Set(stored.catalog_food_aliases.map((alias) => alias.alias));
    return desired.every((alias) => held.has(alias));
};

const samePortions = (stored: StoredFoodWithChildren, desired: readonly PortionColumns[]): boolean => {
    if (stored.catalog_food_portions.length !== desired.length) {
        return false;
    }
    const held = new Map(stored.catalog_food_portions.map((portion) => [portion.description, portion]));
    return desired.every((portion) => {
        const match = held.get(portion.description);
        return match !== undefined && samePortion(match, portion);
    });
};

const sameComponents = (stored: StoredFoodWithChildren, desired: readonly ComponentSpec[]): boolean => {
    if (stored.catalog_food_components.length !== desired.length) {
        return false;
    }
    const held = new Map(
        stored.catalog_food_components.map((component) => [component.component_catalog_foods.source_key, component]),
    );
    return desired.every((component) => {
        const match = held.get(component.componentSourceKey);
        return (
            match !== undefined &&
            sameValue(match.quantity_grams, component.quantity_grams) &&
            sameValue(match.yield_factor, component.yield_factor) &&
            match.component_nutrition_version === component.component_nutrition_version &&
            match.sort_order === component.sort_order
        );
    });
};

/**
 * Whether the release changes anything at all about this food.
 *
 * This is the whole of the idempotence guarantee: when it answers true the food
 * gets no transaction, no statement and no `updated_at` touch.
 */
const foodMatchesRelease = (
    stored: StoredFoodWithChildren | null,
    prepared: PreparedFood,
    desired: FoodColumns,
): boolean =>
    stored !== null &&
    sameFoodColumns(stored, desired) &&
    sameAliases(stored, prepared.aliases) &&
    samePortions(stored, prepared.portions) &&
    sameComponents(stored, prepared.components) &&
    stored.catalog_validation_records !== null &&
    sameValidationRecord(stored.catalog_validation_records, prepared.validation);

/**
 * Replaces this food's compositions with the release's, remapping each
 * `component_food_source_key` to the LOCAL `catalog_foods.id`.
 *
 * Removals run before writes, and only rows the release does not carry are
 * removed, so a composition the release keeps unchanged keeps its row and its
 * id — wholesale replacement as reconciliation, not as delete-then-insert.
 */
const reconcileComponents = async (
    tx: LoadDb,
    foodId: string,
    stored: StoredFoodWithChildren | null,
    desired: readonly ComponentSpec[],
    localIds: ReadonlyMap<string, string>,
    counts: MutableLoadCounts,
): Promise<void> => {
    const desiredKeys = new Set(desired.map((component) => component.componentSourceKey));
    const held = stored?.catalog_food_components ?? [];

    const removedIds = held
        .filter((component) => !desiredKeys.has(component.component_catalog_foods.source_key))
        .map((component) => component.component_catalog_food_id);
    if (removedIds.length > 0) {
        const removed = await tx.catalog_food_components.deleteMany({
            where: { catalog_food_id: foodId, component_catalog_food_id: { in: removedIds } },
        });
        counts.componentsRemoved += removed.count;
    }

    const heldByKey = new Map(held.map((component) => [component.component_catalog_foods.source_key, component]));

    for (const component of desired) {
        const componentId = localIds.get(component.componentSourceKey);
        if (componentId === undefined) {
            // Unreachable: the caller resolves every id before opening this
            // transaction and defers the food when one is missing. Kept as the
            // guarantee itself, because the alternative to a typed refusal here
            // is Prisma's foreign-key error on a RESTRICT column.
            throw new CatalogLoadError(
                'component_reference_unresolved',
                `component "${component.componentSourceKey}" has no local catalog food`,
                { componentSourceKey: component.componentSourceKey },
            );
        }

        const existing = heldByKey.get(component.componentSourceKey);
        const columns = {
            quantity_grams: component.quantity_grams,
            yield_factor: component.yield_factor,
            component_nutrition_version: component.component_nutrition_version,
            sort_order: component.sort_order,
        };
        if (
            existing !== undefined &&
            existing.quantity_grams === columns.quantity_grams &&
            existing.yield_factor === columns.yield_factor &&
            existing.component_nutrition_version === columns.component_nutrition_version &&
            existing.sort_order === columns.sort_order
        ) {
            continue;
        }

        await tx.catalog_food_components.upsert({
            where: {
                catalog_food_id_component_catalog_food_id: {
                    catalog_food_id: foodId,
                    component_catalog_food_id: componentId,
                },
            },
            create: { catalog_food_id: foodId, component_catalog_food_id: componentId, ...columns },
            update: columns,
        });
        counts.componentsWritten += 1;
    }
};

const reconcileAliases = async (
    tx: LoadDb,
    foodId: string,
    stored: StoredFoodWithChildren | null,
    desired: readonly string[],
    counts: MutableLoadCounts,
): Promise<void> => {
    const held = new Set((stored?.catalog_food_aliases ?? []).map((alias) => alias.alias));
    const wanted = new Set(desired);

    const removed = [...held].filter((alias) => !wanted.has(alias));
    if (removed.length > 0) {
        const result = await tx.catalog_food_aliases.deleteMany({
            where: { catalog_food_id: foodId, alias: { in: removed } },
        });
        counts.aliasesRemoved += result.count;
    }

    const added = [...wanted].filter((alias) => !held.has(alias));
    if (added.length > 0) {
        const result = await tx.catalog_food_aliases.createMany({
            data: added.map((alias) => ({ catalog_food_id: foodId, alias })),
            skipDuplicates: true,
        });
        counts.aliasesWritten += result.count;
    }
};

const reconcilePortions = async (
    tx: LoadDb,
    foodId: string,
    stored: StoredFoodWithChildren | null,
    desired: readonly PortionColumns[],
    counts: MutableLoadCounts,
): Promise<void> => {
    const held = new Map((stored?.catalog_food_portions ?? []).map((portion) => [portion.description, portion]));
    const wanted = new Map(desired.map((portion) => [portion.description, portion]));

    const removed = [...held.keys()].filter((description) => !wanted.has(description));
    if (removed.length > 0) {
        const result = await tx.catalog_food_portions.deleteMany({
            where: { catalog_food_id: foodId, description: { in: removed } },
        });
        counts.portionsRemoved += result.count;
    }

    // NON-DEFAULT PORTIONS FIRST. `unique_default_catalog_food_portion` is a
    // partial unique index over `catalog_food_id WHERE is_default`, enforced per
    // statement rather than at commit, so a release that moves the default from
    // one portion to another must clear the old default BEFORE setting the new
    // one. Ordering the writes by `is_default` ascending does exactly that, and
    // it is the reason this loop is not a plain `for … of desired`.
    const ordered = [...wanted.values()].sort(
        (left, right) => Number(left.is_default) - Number(right.is_default),
    );

    for (const portion of ordered) {
        const existing = held.get(portion.description);
        if (existing === undefined) {
            await tx.catalog_food_portions.create({ data: { catalog_food_id: foodId, ...portion } });
            counts.portionsWritten += 1;
            continue;
        }
        if (samePortion(existing, portion)) {
            continue;
        }
        await tx.catalog_food_portions.update({
            where: {
                catalog_food_id_description: { catalog_food_id: foodId, description: portion.description },
            },
            data: portion,
        });
        counts.portionsWritten += 1;
    }
};

const reconcileValidationRecord = async (
    tx: LoadDb,
    foodId: string,
    stored: StoredFoodWithChildren | null,
    desired: ValidationColumns,
    counts: MutableLoadCounts,
): Promise<void> => {
    const existing = stored?.catalog_validation_records ?? null;
    if (existing !== null && sameValidationRecord(existing, desired)) {
        return;
    }

    await tx.catalog_validation_records.upsert({
        where: { catalog_food_id: foodId },
        create: { catalog_food_id: foodId, ...desired },
        update: desired,
    });
    counts.validationRecordsWritten += 1;
};

/**
 * What the four child reconcilers WOULD write and remove for this food, derived
 * from the already-prefetched stored state.
 *
 * It exists for the dry run, which must report the same reconciliation the real
 * load applies without issuing a statement (`--dry-run` in the usage block and
 * step 4 of the runbook both promise that), and it is pure for the same reason
 * the comparators above are: every branch it takes mirrors one in
 * `reconcileAliases`, `reconcilePortions`, `reconcileComponents` and
 * `reconcileValidationRecord`, so a change to either side that drifts from the
 * other is visible in one place rather than in a count nobody can explain.
 */
interface ChildDelta {
    readonly aliasesWritten: number;
    readonly aliasesRemoved: number;
    readonly portionsWritten: number;
    readonly portionsRemoved: number;
    readonly componentsWritten: number;
    readonly componentsRemoved: number;
    readonly validationRecordsWritten: number;
}

const planChildWrites = (stored: StoredFoodWithChildren | null, prepared: PreparedFood): ChildDelta => {
    const heldAliases = new Set((stored?.catalog_food_aliases ?? []).map((alias) => alias.alias));
    const wantedAliases = new Set(prepared.aliases);

    const heldPortions = new Map((stored?.catalog_food_portions ?? []).map((portion) => [portion.description, portion]));
    const wantedPortions = new Map(prepared.portions.map((portion) => [portion.description, portion]));

    const heldComponents = new Map(
        (stored?.catalog_food_components ?? []).map((component) => [
            component.component_catalog_foods.source_key,
            component,
        ]),
    );
    const wantedComponents = new Set(prepared.components.map((component) => component.componentSourceKey));

    const storedRecord = stored?.catalog_validation_records ?? null;

    return {
        aliasesWritten: [...wantedAliases].filter((alias) => !heldAliases.has(alias)).length,
        aliasesRemoved: [...heldAliases].filter((alias) => !wantedAliases.has(alias)).length,
        // A portion that exists and differs is UPDATED, which is a write; one
        // that exists and matches costs no statement at all.
        portionsWritten: [...wantedPortions.values()].filter((portion) => {
            const existing = heldPortions.get(portion.description);
            return existing === undefined || !samePortion(existing, portion);
        }).length,
        portionsRemoved: [...heldPortions.keys()].filter((description) => !wantedPortions.has(description)).length,
        componentsWritten: prepared.components.filter((component) => {
            const existing = heldComponents.get(component.componentSourceKey);
            return (
                existing === undefined ||
                existing.quantity_grams !== component.quantity_grams ||
                existing.yield_factor !== component.yield_factor ||
                existing.component_nutrition_version !== component.component_nutrition_version ||
                existing.sort_order !== component.sort_order
            );
        }).length,
        componentsRemoved: [...heldComponents.keys()].filter((key) => !wantedComponents.has(key)).length,
        validationRecordsWritten:
            storedRecord === null || !sameValidationRecord(storedRecord, prepared.validation) ? 1 : 0,
    };
};

const addChildDelta = (counts: MutableLoadCounts, delta: ChildDelta): void => {
    counts.aliasesWritten += delta.aliasesWritten;
    counts.aliasesRemoved += delta.aliasesRemoved;
    counts.portionsWritten += delta.portionsWritten;
    counts.portionsRemoved += delta.portionsRemoved;
    counts.componentsWritten += delta.componentsWritten;
    counts.componentsRemoved += delta.componentsRemoved;
    counts.validationRecordsWritten += delta.validationRecordsWritten;
};

/**
 * Applies one food and its children.
 *
 * The food's own transaction is short and holds exactly the writes that must
 * succeed or fail together: the food row, and its aliases, portions,
 * compositions and validation record — all four child sets replaced wholesale
 * inside it, which is what AAP §0.7.1 Group 3 requires. `prefetched` is the
 * chunk's read-ahead and is only a FILTER — the row is read again inside the
 * transaction, because a decision taken from a read outside it would be stale
 * by the time it is acted on.
 *
 * A WHOLE FOOD MAY BE DEFERRED, and nothing partial is ever committed. A
 * composition points at another food in the same release, and `foods.jsonl` is
 * ordered by `source_key`, so a parent routinely appears BEFORE its components
 * (in the shipped fixtures, `ai:condiment_sauce:lemon olive oil dressing:prepared`
 * sorts before the `usda:` foods it is derived from). The component food
 * therefore does not exist yet on a first load, and
 * `catalog_food_components.component_catalog_food_id` is RESTRICT: writing the
 * row would be refused by PostgreSQL. Deferring the COMPOSITION alone would
 * publish an `ingredient_derived` food whose nutrient totals have nothing
 * behind them and would put that food behind the cursor watermark, so an
 * interrupted load could never repair it. The whole food is therefore queued
 * instead — `'deferred'`, not one statement issued — and applied by
 * `applyDeferredFoods` through this same path once its targets resolve. A
 * component neither this database holds nor the release carries can never
 * resolve and is refused immediately, naming both keys.
 */
const applyFood = async (
    deps: LoadDeps,
    prepared: PreparedFood,
    prefetched: StoredFoodWithChildren | null,
    foodOrder: ReadonlyMap<string, number>,
    state: LoadState,
): Promise<ApplyOutcome> => {
    const batchId =
        prepared.generationBatchKey === null ? null : state.batchIdByKey.get(prepared.generationBatchKey) ?? null;
    const desired: FoodColumns = { ...prepared.scalars, generation_batch_id: batchId };

    // Local resolution is tried FIRST, and release membership only decides what
    // an unresolved reference means. A release can legitimately carry a
    // composition pointing at a food it does not itself export — the exporter
    // emits a component row whatever the component food's own publication
    // status — and such a reference is perfectly loadable into a database that
    // already holds that food. Only a reference that resolves to nothing local
    // AND to nothing in the release can never resolve, and that is the hard
    // refusal.
    const resolvedComponentIds = new Map<string, string>();
    const unresolved: ComponentSpec[] = [];
    for (const component of prepared.components) {
        const localId = state.localIdBySourceKey.get(component.componentSourceKey);
        if (localId === undefined) {
            unresolved.push(component);
            continue;
        }
        resolvedComponentIds.set(component.componentSourceKey, localId);
    }

    for (const component of unresolved) {
        if (!foodOrder.has(component.componentSourceKey)) {
            throw new CatalogLoadError(
                'component_reference_unresolved',
                `food "${prepared.sourceKey}" is derived from component "${component.componentSourceKey}", which ` +
                    `neither this database holds nor ${FOODS_FILE} carries, so the composition can never be stored ` +
                    'and its nutrient totals would have no composition behind them',
                {
                    file: COMPONENTS_FILE,
                    line: component.line,
                    sourceKey: prepared.sourceKey,
                    componentSourceKey: component.componentSourceKey,
                },
            );
        }
    }

    if (foodMatchesRelease(prefetched, prepared, desired)) {
        // Settled without a statement, whether or not its components resolve
        // locally: the stored composition already states what the release does.
        return 'unchanged';
    }

    if (deps.dryRun) {
        // The planned outcome, read from the prefetch: a dry run opens no
        // transaction and issues no statement, so what it reports is what the
        // comparisons above already established — including, through
        // `planChildWrites`, the alias, portion, composition and
        // validation-record rows the four reconcilers would write and remove.
        // It never defers: nothing is written, so no reference could resolve
        // later, and reporting a would-insert as deferred would hide it.
        if (prefetched !== null && prefetched.publication_status === RETIRED && desired.publication_status === PUBLISHED) {
            state.counts.foodsRestored += 1;
        }
        addChildDelta(state.counts, planChildWrites(prefetched, prepared));
        return prefetched === null ? 'inserted' : 'updated';
    }

    if (unresolved.length > 0) {
        // NOTHING IS WRITTEN FOR THIS FOOD. Not the row, not an alias, not a
        // portion, not its validation record — see the deferral paragraph
        // above. The caller queues it and the fixpoint pass applies it whole.
        deps.logger.debug('food_deferred', {
            stage: STAGE,
            release: deps.release,
            sourceKey: prepared.sourceKey,
            componentSourceKey: unresolved[0].componentSourceKey,
            pendingComponents: unresolved.length,
        });
        return 'deferred';
    }

    const outcome = await deps.db.$transaction(
        async (tx): Promise<FoodOutcome> => {
            const current = await readFoodWithChildren(tx, prepared.sourceKey);
            if (foodMatchesRelease(current, prepared, desired)) {
                return 'unchanged';
            }

            let foodId: string;
            let applied: FoodOutcome;
            if (current === null) {
                // `id` is never written: the column's database default mints it,
                // which is what keeps a reloaded food's identity — and every
                // recipe_ingredients and meal_entries row pointing at it —
                // stable across releases.
                foodId = (await tx.catalog_foods.create({ data: desired })).id;
                applied = 'inserted';
            } else {
                if (!sameFoodColumns(current, desired)) {
                    // Keyed on `source_key`, the release's stable identity, and
                    // only when a column actually moved: an update that changed
                    // nothing would still touch `updated_at` (`@updatedAt`).
                    await tx.catalog_foods.update({ where: { source_key: prepared.sourceKey }, data: desired });
                }
                if (current.publication_status === RETIRED && desired.publication_status === PUBLISHED) {
                    state.counts.foodsRestored += 1;
                }
                foodId = current.id;
                applied = 'updated';
            }

            state.localIdBySourceKey.set(prepared.sourceKey, foodId);

            // All four child sets, wholesale, inside this one transaction: the
            // food is published with its composition or not published at all.
            await reconcileAliases(tx, foodId, current, prepared.aliases, state.counts);
            await reconcilePortions(tx, foodId, current, prepared.portions, state.counts);
            await reconcileComponents(tx, foodId, current, prepared.components, resolvedComponentIds, state.counts);
            await reconcileValidationRecord(tx, foodId, current, prepared.validation, state.counts);

            return applied;
        },
        { timeout: TRANSACTION_TIMEOUT_MS },
    );

    return outcome;
};

/** Counts one settled food and reports it to the progress seam. */
const settleFood = async (
    deps: LoadDeps,
    food: PreparedFood,
    outcome: FoodOutcome,
    state: LoadState,
): Promise<void> => {
    if (outcome === 'inserted') {
        state.counts.foodsInserted += 1;
    } else if (outcome === 'updated') {
        state.counts.foodsUpdated += 1;
    } else {
        state.counts.foodsUnchanged += 1;
    }

    if (deps.onFoodSettled !== undefined) {
        await deps.onFoodSettled({ sourceKey: food.sourceKey, outcome, index: food.index });
    }
};

/**
 * Looks up the local ids of component targets this run has not seen, in one
 * batched read per chunk of keys.
 *
 * A resumed run is why this exists: the foods a previous attempt settled are
 * skipped rather than reapplied, so they never enter `localIdBySourceKey`, and
 * a deferred food's target is routinely one of them.
 */
const resolveComponentTargets = async (
    deps: LoadDeps,
    foods: readonly PreparedFood[],
    state: LoadState,
): Promise<void> => {
    const wanted = new Set<string>();
    for (const food of foods) {
        for (const component of food.components) {
            if (!state.localIdBySourceKey.has(component.componentSourceKey)) {
                wanted.add(component.componentSourceKey);
            }
        }
    }
    if (wanted.size === 0) {
        return;
    }

    for (const chunk of chunked([...wanted], CHUNK_SIZE)) {
        const rows = (await deps.db.catalog_foods.findMany({
            where: { source_key: { in: chunk } },
            select: { id: true, source_key: true },
        })) as readonly { readonly id: string; readonly source_key: string }[];
        for (const row of rows) {
            state.localIdBySourceKey.set(row.source_key, row.id);
        }
    }
};

/**
 * The refusal a stalled deferred queue earns, naming the food and the component
 * that cannot resolve.
 *
 * One code covers both shapes because an operator's remedy is the same: the
 * release claims a derivation nothing can satisfy, so it has to be reproduced.
 * A CYCLE (A's composition names B and B's names A) can never be broken by any
 * ordering, and a target the load did not produce is a release whose
 * `foods.jsonl` and `components.jsonl` disagree.
 */
const deferredRefusal = (food: PreparedFood, state: LoadState): CatalogLoadError => {
    const component = food.components.find(
        (candidate) => !state.localIdBySourceKey.has(candidate.componentSourceKey),
    );

    return new CatalogLoadError(
        'component_reference_unresolved',
        `food "${food.sourceKey}" is derived from component "${component?.componentSourceKey ?? 'unknown'}", which ` +
            'is still not stored after every food this release could load was loaded. The reference is either ' +
            'circular — two foods in this release derive from each other — or names a food neither the release nor ' +
            'this database produced. Nothing was written for it, the run is recorded as failed and the active ' +
            'release pointer has not moved.',
        {
            file: COMPONENTS_FILE,
            line: component?.line,
            sourceKey: food.sourceKey,
            componentSourceKey: component?.componentSourceKey,
        },
    );
};

/**
 * Applies the foods `applyFood` deferred, sweeping to a FIXPOINT.
 *
 * Each sweep applies every queued food whose component targets now resolve —
 * through `applyFood`, so all four child sets still land in that food's own
 * single transaction — and requeues the rest. Progress in one sweep can unblock
 * another food (a chain A→B→C the release states in that order), so the sweeps
 * repeat while any food is applied. A sweep that applies NOTHING while foods
 * remain queued is the fixpoint: no ordering can resolve what is left, and it
 * is refused rather than left as a published food with no composition.
 *
 * The queue is empty on a dry run by construction — `applyFood` never defers
 * there — so this is a no-op on that path rather than a branch on it.
 */
const applyDeferredFoods = async (
    deps: LoadDeps,
    verification: ReleaseVerification,
    state: LoadState,
): Promise<void> => {
    if (state.deferred.length === 0) {
        return;
    }

    const queued = state.deferred.length;
    let pending = state.deferred.splice(0, state.deferred.length);
    let sweep = 0;

    for (;;) {
        sweep += 1;
        await resolveComponentTargets(deps, pending, state);

        // The same read-ahead the main pass uses, for the same reason: a
        // deferred food a previous attempt already applied must cost no
        // transaction on the rerun that repairs the rest.
        const prefetched = await prefetchFoods(deps.db, pending.map((food) => food.sourceKey));
        const stillPending: PreparedFood[] = [];
        let applied = 0;

        for (const food of pending) {
            const outcome = await applyFood(
                deps,
                food,
                prefetched.get(food.sourceKey) ?? null,
                verification.foodOrder,
                state,
            );
            if (outcome === 'deferred') {
                stillPending.push(food);
                continue;
            }
            applied += 1;
            await settleFood(deps, food, outcome, state);
        }

        deps.logger.info('deferred_foods_swept', {
            stage: STAGE,
            release: deps.release,
            sweep,
            queued,
            applied,
            stillPending: stillPending.length,
        });

        if (stillPending.length === 0) {
            return;
        }
        if (applied === 0) {
            throw deferredRefusal(stillPending[0], state);
        }
        pending = stillPending;
    }
};

// ---------------------------------------------------------------------------
// Retirement, and the post-load comparison.
// ---------------------------------------------------------------------------

/**
 * A locally published food this release does not carry becomes `retired`.
 *
 * WHY IT RUNS BEFORE THE UPSERTS. `unique_published_catalog_food_identity` is a
 * partial unique index over `(canonical_name, food_state) WHERE
 * publication_status = 'published'`, so a release that RE-SOURCES an identity —
 * dropping `usda:123` and carrying `usda:456` with the same canonical name and
 * state, which is what a corrected FDC id looks like — could not be applied
 * while the dropped food was still published. Retiring first is also the
 * honest reading of the artefact: a release is a statement of desired state,
 * and "these are the published foods" is part of it.
 *
 * The diff is computed in memory from the local published keys rather than
 * pushed into the database as an 11,046-element `notIn`, and no statement is
 * issued at all when nothing is absent — which is what keeps a rerun free of
 * writes beyond the run row.
 */
const retireAbsentFoods = async (
    deps: LoadDeps,
    releaseKeys: ReadonlySet<string>,
    state: LoadState,
): Promise<readonly string[]> => {
    const published = (await deps.db.catalog_foods.findMany({
        where: { publication_status: PUBLISHED },
        select: { source_key: true },
    })) as readonly { readonly source_key: string }[];

    const absent = published.map((row) => row.source_key).filter((key) => !releaseKeys.has(key)).sort();
    if (absent.length === 0 || deps.dryRun) {
        return absent;
    }

    for (const chunk of chunked(absent, RETIRE_CHUNK_SIZE)) {
        const result = await deps.db.catalog_foods.updateMany({
            // The status predicate is part of the identity of the write, not
            // decoration: only a PUBLISHED food is retired, so a row another
            // stage moved between the read above and this statement is left
            // alone rather than overwritten.
            where: { source_key: { in: chunk }, publication_status: PUBLISHED },
            data: { publication_status: RETIRED },
        });
        state.counts.foodsRetired += result.count;
    }

    deps.logger.info('foods_retired', {
        stage: STAGE,
        release: deps.release,
        retired: state.counts.foodsRetired,
        // Named, not just counted: retirement is the one part of a load that
        // removes a food from search, and an operator has to be able to see
        // which. Capped so a pathological release cannot write an unbounded line.
        sourceKeys: absent.slice(0, 20).join(', '),
        truncated: absent.length > 20,
    });

    return absent;
};

/**
 * The post-load comparison, and the gate on activation.
 *
 * A release carries the published set only, so after a load the published foods
 * ARE the release's foods and every child of a published food is a child the
 * release states. That is what makes these counts comparable at all: they are
 * counted through a published-parent relation filter, so the children of a
 * retired food — which stay in place, referenceable — are correctly excluded.
 *
 * The zero-component case is PROVED rather than assumed, through the same pure
 * rule catalog-release.ts asserts at export time: a published
 * `ingredient_derived` food with no resolvable composition has nothing its
 * nutrient totals could have been derived from, so `components: 0` is correct
 * exactly when no published food derives its nutrition.
 */
const verifyLoadedCounts = async (deps: LoadDeps): Promise<readonly CountCheck[]> => {
    const counts = deps.manifest.counts;
    const publishedParent = { catalog_foods: { publication_status: PUBLISHED } };

    const observed = {
        publishedFoods: await deps.db.catalog_foods.count({ where: { publication_status: PUBLISHED } }),
        aliases: await deps.db.catalog_food_aliases.count({ where: publishedParent }),
        portions: await deps.db.catalog_food_portions.count({ where: publishedParent }),
        components: await deps.db.catalog_food_components.count({ where: publishedParent }),
        validationRecords: await deps.db.catalog_validation_records.count({ where: publishedParent }),
    };

    const facts = (await deps.db.catalog_foods.findMany({
        where: { publication_status: PUBLISHED, nutrition_provenance: INGREDIENT_DERIVED },
        select: {
            source_key: true,
            nutrition_provenance: true,
            _count: { select: { catalog_food_components: true } },
        },
    })) as readonly {
        readonly source_key: string;
        readonly nutrition_provenance: string;
        readonly _count: { readonly catalog_food_components: number };
    }[];

    const coverage = assessComponentCoverage(
        facts.map((fact) => ({
            source_key: fact.source_key,
            nutrition_provenance: fact.nutrition_provenance,
            // Every stored component resolves by construction: the column is a
            // NOT NULL foreign key, so a row exists only while its component
            // food does.
            resolvable_component_count: fact._count.catalog_food_components,
        })),
    );

    const checks: CountCheck[] = [
        { name: 'published_foods', expected: counts.published_foods ?? counts.foods, observed: observed.publishedFoods },
        { name: 'aliases', expected: counts.aliases, observed: observed.aliases },
        { name: 'portions', expected: counts.portions, observed: observed.portions },
        { name: 'components', expected: counts.components, observed: observed.components },
        { name: 'validation_records', expected: counts.validation_records, observed: observed.validationRecords },
    ].map((check) => ({ ...check, ok: check.expected === check.observed }));

    if (counts.published_ingredient_derived !== undefined) {
        checks.push({
            name: 'published_ingredient_derived',
            expected: counts.published_ingredient_derived,
            observed: coverage.derivedCount,
            ok: counts.published_ingredient_derived === coverage.derivedCount,
        });
    }

    for (const check of checks) {
        deps.logger.info('count_verified', {
            stage: STAGE,
            release: deps.release,
            check: check.name,
            expected: check.expected,
            observed: check.observed,
            ok: check.ok,
        });
    }

    const failed = checks.filter((check) => !check.ok);
    if (failed.length > 0) {
        throw new CatalogLoadError(
            'count_verification_failed',
            `the load does not match ${deps.release}'s manifest: ${failed
                .map((check) => `${check.name} expected ${check.expected}, observed ${check.observed}`)
                .join('; ')}. The run is recorded as failed and the active release pointer has not moved.`,
            {
                expected: failed[0].expected,
                observed: failed[0].observed,
            },
        );
    }

    if (!coverage.ok) {
        const missing = coverage.derivedWithoutComponents;
        throw new CatalogLoadError(
            'component_coverage_failed',
            `${missing.length} published food(s) declare nutrition_provenance '${INGREDIENT_DERIVED}' but hold no ` +
                `component rows after the load, so their nutrient totals have no stored composition: ${missing
                    .slice(0, 5)
                    .join(', ')}${missing.length > 5 ? ', …' : ''}. The run is recorded as failed and the active ` +
                'release pointer has not moved.',
            { sourceKey: missing[0], expected: 1, observed: 0 },
        );
    }

    return checks;
};

// ---------------------------------------------------------------------------
// The load.
// ---------------------------------------------------------------------------

/**
 * What has happened since the last checkpoint. `recordCounts` is ADDITIVE, so a
 * run must hand it the delta rather than the running total — which is also what
 * lets a resumed run accumulate correctly across attempts.
 */
const countsDelta = (counts: MutableLoadCounts, recorded: MutableLoadCounts): Record<string, number> => {
    const delta: Record<string, number> = {};
    for (const key of Object.keys(counts) as (keyof LoadCounts)[]) {
        const difference = counts[key] - recorded[key];
        if (difference !== 0) {
            delta[key] = difference;
            recorded[key] = counts[key];
        }
    }
    return delta;
};

const saveProgress = async (
    deps: LoadDeps,
    runId: string,
    state: LoadState,
    verification: ReleaseVerification,
): Promise<void> => {
    await saveCursor<LoadCursor>(deps.runDb, runId, {
        releaseId: deps.release,
        foodsSha256: verification.foodsSha256,
        verifiedFiles: verification.members.map((member) => member.file),
        lastSourceKey: state.lastSourceKey,
    });

    const delta = countsDelta(state.counts, state.recorded);
    if (Object.keys(delta).length > 0) {
        await recordCounts(deps.runDb, runId, delta);
    }
};

const applyChunk = async (
    deps: LoadDeps,
    chunk: readonly PreparedFood[],
    verification: ReleaseVerification,
    state: LoadState,
): Promise<void> => {
    const batchKeys = chunk
        .map((food) => food.generationBatchKey)
        .filter((key): key is string => key !== null);
    if (batchKeys.length > 0) {
        await resolveGenerationBatches(deps, batchKeys, state);
    }

    // THE SKIP FILTER. One read per chunk answers "does the release change this
    // food?" for 250 foods at once, so an unchanged food costs one row of a
    // batched read instead of a transaction. It is a filter and not a decision:
    // `applyFood` reads the row again inside its own transaction.
    const prefetched = await prefetchFoods(deps.db, chunk.map((food) => food.sourceKey));
    for (const [sourceKey, row] of prefetched) {
        state.localIdBySourceKey.set(sourceKey, row.id);
    }

    const componentKeys = new Set<string>();
    for (const food of chunk) {
        for (const component of food.components) {
            if (!state.localIdBySourceKey.has(component.componentSourceKey)) {
                componentKeys.add(component.componentSourceKey);
            }
        }
    }
    if (componentKeys.size > 0) {
        const rows = (await deps.db.catalog_foods.findMany({
            where: { source_key: { in: [...componentKeys] } },
            select: { id: true, source_key: true },
        })) as readonly { readonly id: string; readonly source_key: string }[];
        for (const row of rows) {
            state.localIdBySourceKey.set(row.source_key, row.id);
        }
    }

    for (const food of chunk) {
        const outcome = await applyFood(
            deps,
            food,
            prefetched.get(food.sourceKey) ?? null,
            verification.foodOrder,
            state,
        );

        state.lastProcessedKey = food.sourceKey;

        if (outcome === 'deferred') {
            state.counts.foodsDeferred += 1;
            state.deferred.push(food);
            // No `onFoodSettled` and no watermark advance: this food is not
            // settled, and the watermark is now FROZEN at the last food that
            // was (see `LoadCursor.lastSourceKey`), so a checkpoint taken from
            // here can never let a resumed run skip past it.
            continue;
        }

        // Only while nothing is outstanding: a deferred food earlier in the
        // release holds the watermark back until the deferred pass drains it.
        if (state.deferred.length === 0) {
            state.lastSourceKey = food.sourceKey;
        }

        await settleFood(deps, food, outcome, state);
    }
};

const applyRelease = async (
    deps: LoadDeps,
    verification: ReleaseVerification,
    state: LoadState,
    runId: string | null,
    resumeAfter: string | null,
): Promise<void> => {
    const cursors = openReleaseCursors(deps.releaseRoot, verification);
    let skipping = resumeAfter !== null;

    try {
        let index = 0;
        let chunk: PreparedFood[] = [];

        for (;;) {
            const prepared = await readPreparedFood(cursors, verification.foodOrder, index);
            if (prepared === null) {
                break;
            }
            index += 1;

            if (skipping) {
                // A previous attempt settled this food. Its children are still
                // consumed from their members, because the four cursors only
                // stay aligned with `foods.jsonl` if every group is read.
                state.counts.foodsSkippedByCursor += 1;
                // Settled by that attempt — the watermark only ever named
                // settled foods — so the watermark may pass it.
                state.lastProcessedKey = prepared.sourceKey;
                state.lastSourceKey = prepared.sourceKey;
                if (prepared.sourceKey === resumeAfter) {
                    skipping = false;
                }
                continue;
            }

            chunk.push(prepared);
            if (chunk.length >= CHUNK_SIZE) {
                await applyChunk(deps, chunk, verification, state);
                chunk = [];
                if (runId !== null) {
                    await saveProgress(deps, runId, state, verification);
                }
                deps.logger.info('load_progress', {
                    stage: STAGE,
                    release: deps.release,
                    foods: index,
                    ofFoods: verification.foodOrder.size,
                    inserted: state.counts.foodsInserted,
                    updated: state.counts.foodsUpdated,
                    unchanged: state.counts.foodsUnchanged,
                });
            }
        }

        if (chunk.length > 0) {
            await applyChunk(deps, chunk, verification, state);
        }

        await assertMembersExhausted(cursors, verification.foodOrder);

        // BEFORE THE DEFERRED PASS AND BEFORE THE COUNTS: the bytes this pass
        // applied are compared with the bytes that were verified, so a member
        // that changed between the two reads can neither be completed nor
        // activated (see THE TWO READS in this file's header).
        verifyAppliedMembers(deps, cursors, verification);

        await applyDeferredFoods(deps, verification, state);

        // The queue is drained, so every food this attempt read is settled and
        // the watermark catches up to the last of them in one move.
        state.lastSourceKey = state.lastProcessedKey;

        if (runId !== null) {
            await saveProgress(deps, runId, state, verification);
        }
    } finally {
        // Unconditional: five read streams are open, and leaving them behind
        // would hold file handles for the life of the process — which for the
        // suite is the life of the Jest worker.
        closeReleaseCursors(cursors);
    }
};

/**
 * Where a resumed run picks up, or `null` to start over.
 *
 * A cursor is a position in a FILE, so it is only meaningful against the same
 * file: a stored digest that no longer matches `foods.jsonl` means the release
 * changed under the run, and resuming into that position would skip foods the
 * new release states. Starting over is the correct reading of it, and it is
 * cheap rather than dangerous because an already-applied food is `unchanged`.
 */
const resumePositionFrom = (
    cursor: unknown,
    deps: LoadDeps,
    verification: ReleaseVerification,
): string | null => {
    if (cursor === null || typeof cursor !== 'object') {
        return null;
    }

    const stored = cursor as Partial<LoadCursor>;
    if (stored.releaseId !== deps.release || stored.foodsSha256 !== verification.foodsSha256) {
        deps.logger.warn('cursor_release_changed', {
            stage: STAGE,
            release: deps.release,
            storedRelease: typeof stored.releaseId === 'string' ? stored.releaseId : null,
            note: 'the stored checkpoint does not describe the release on disk, so the load starts over',
        });
        return null;
    }

    const lastSourceKey = stored.lastSourceKey;
    if (typeof lastSourceKey !== 'string' || !verification.foodOrder.has(lastSourceKey)) {
        return null;
    }

    deps.logger.info('resuming_after_food', { stage: STAGE, release: deps.release, sourceKey: lastSourceKey });

    return lastSourceKey;
};

const closeFailedRun = async (deps: LoadDeps, runId: string, state: LoadState, error: unknown): Promise<void> => {
    try {
        // This call IS the non-activation: a run closed 'failed' can never be
        // the newest succeeded `release_load` row, so the previous release stays
        // active with no compensating write and no pointer to roll back.
        await finishRun(deps.runDb, runId, 'failed', {
            counts: countsDelta(state.counts, state.recorded),
            error,
            logger: deps.logger,
        });
    } catch (closeError) {
        // The original failure is what an operator has to act on, so a failure
        // to record it is reported beside it and never in place of it — the
        // caller rethrows the first error.
        deps.logger.error('run_close_failed', { stage: STAGE, runId, error: safeError(closeError) });
    }
};

/**
 * Loads one reviewed release: verify, claim a run, retire what the release
 * dropped, reconcile every food, verify the counts, and only then record the run
 * as succeeded — which is what makes it the active release.
 *
 * Every step and the reasons for their order are in this file's header. The
 * entry point below is deliberately thin around this call: everything a test
 * needs to drive — the database, the run ledger, the release directory, the
 * clock and the dry-run switch — arrives through `LoadDeps`.
 */
export const runLoad = async (deps: LoadDeps): Promise<LoadSummary> => {
    const { logger } = deps;

    // Defence in depth for a caller that reached here without preflight, which
    // reports the same mismatch as a prerequisite gap: a manifest describing
    // another release would otherwise be verified against ITS digests and then
    // activated under this release's id.
    if (deps.manifest.release_id !== deps.release) {
        throw new CatalogLoadError(
            'release_id_mismatch',
            `the manifest declares release "${String(deps.manifest.release_id)}" and this run was asked to load ` +
                `"${deps.release}"`,
            { expected: deps.release, observed: String(deps.manifest.release_id) },
        );
    }

    const verification = await verifyRelease(deps);

    if (deps.onReleaseVerified !== undefined) {
        await deps.onReleaseVerified({ members: verification.members });
    }

    const releaseKeys = new Set(verification.foodOrder.keys());
    const state: LoadState = {
        counts: emptyCounts(),
        recorded: emptyCounts(),
        localIdBySourceKey: new Map(),
        batchIdByKey: new Map(),
        deferred: [],
        lastSourceKey: null,
        lastProcessedKey: null,
    };

    if (deps.dryRun) {
        // NO RUN ROW, NO CURSOR, NO COMPLETION. A run is claimed by
        // (kind, manifest_version) and manifest_version carries the release id,
        // so a dry run that claimed it would report what it WOULD write and
        // thereby stop the real load from ever writing it.
        assertReleaseUnchanged(deps, verification);
        const retiredSourceKeys = await retireAbsentFoods(deps, releaseKeys, state);
        await applyRelease(deps, verification, state, null, null);

        logger.info('dry_run_planned', {
            stage: STAGE,
            release: deps.release,
            foods: verification.foodOrder.size,
            wouldInsert: state.counts.foodsInserted,
            wouldUpdate: state.counts.foodsUpdated,
            unchanged: state.counts.foodsUnchanged,
            wouldRetire: retiredSourceKeys.length,
            wouldRestore: state.counts.foodsRestored,
            wouldWriteAliases: state.counts.aliasesWritten,
            wouldRemoveAliases: state.counts.aliasesRemoved,
            wouldWritePortions: state.counts.portionsWritten,
            wouldRemovePortions: state.counts.portionsRemoved,
            wouldWriteComponents: state.counts.componentsWritten,
            wouldRemoveComponents: state.counts.componentsRemoved,
            wouldWriteValidationRecords: state.counts.validationRecordsWritten,
            note: 'no row was written, no run was opened and the active release pointer was not read, so the release still has to be loaded',
        });

        return {
            runId: null,
            release: deps.release,
            resumed: false,
            dryRun: true,
            activated: false,
            counts: { ...state.counts },
            verification: verification.members,
            countChecks: [],
            retiredSourceKeys,
        };
    }

    const initialCursor: LoadCursor = {
        releaseId: deps.release,
        foodsSha256: verification.foodsSha256,
        verifiedFiles: verification.members.map((member) => member.file),
        lastSourceKey: null,
    };

    const claim = await openOrResumeRun<LoadCursor>(deps.runDb, {
        kind: RELEASE_LOAD_RUN_KIND,
        manifestVersion: deps.release,
        initialCursor,
        logger,
        now: deps.now,
    });

    let run: CatalogRun<LoadCursor> = claim.run;
    let resumed = claim.resumed;

    if (claim.alreadyCompleted) {
        // A SECOND LOAD OF AN ALREADY-LOADED RELEASE RUNS, AND OPENS ITS OWN ROW.
        //
        // This is the one place this stage departs from the other three, and
        // deliberately. For them a completed run means the work is done and
        // `alreadyCompleted` is the signal to stop. A release is not an action
        // though — it is a statement of desired state — and AAP §0.9.1 requires
        // the second load of v1 to RUN and report 0 inserts and 0 updates,
        // which is only evidence if the load actually reconciles. Writing this
        // invocation's progress into the settled row is equally wrong: its
        // `counts` and `finished_at` are finished evidence of the first load.
        // So a fresh row is opened for this invocation, and the previous one is
        // left exactly as it was.
        logger.info('run_already_completed', {
            stage: STAGE,
            release: deps.release,
            previousRunId: claim.run.id,
            counts: JSON.stringify(claim.run.counts),
            note: 'a release is desired state, so this invocation reconciles again under a new run row',
        });
        run = await openRun<LoadCursor>(deps.runDb, {
            kind: RELEASE_LOAD_RUN_KIND,
            manifestVersion: deps.release,
            cursor: initialCursor,
            logger,
        });
        resumed = false;
    }

    const resumeAfter = resumed ? resumePositionFrom(run.cursor, deps, verification) : null;

    try {
        // Written before the first food: the cursor records that this attempt
        // verified every member against the manifest, which is the one thing a
        // later reader of the row cannot otherwise tell.
        await saveProgress(deps, run.id, state, verification);

        // AHEAD OF THE FIRST WRITE. Retirement is the load's earliest row
        // write, so the cheap identity check runs before it: a release that
        // changed since it was verified costs no write at all, rather than a
        // retirement that a later refusal would leave behind.
        assertReleaseUnchanged(deps, verification);

        const retiredSourceKeys = await retireAbsentFoods(deps, releaseKeys, state);
        await applyRelease(deps, verification, state, run.id, resumeAfter);

        const countChecks = await verifyLoadedCounts(deps);

        await finishRun(deps.runDb, run.id, 'succeeded', {
            counts: countsDelta(state.counts, state.recorded),
            logger,
        });

        // The pointer is READ BACK rather than assumed: "which release is
        // active" is exactly this query's answer, and it is the same rule
        // GET /api/catalog/status reports.
        const active = await getActiveReleaseLoad(deps.runDb);
        const activated = active !== null && active.runId === run.id;
        if (activated) {
            logger.info('release_activated', {
                stage: STAGE,
                release: deps.release,
                runId: run.id,
                publishedFoods: countChecks.find((check) => check.name === 'published_foods')?.observed ?? 0,
            });
        } else {
            // Reachable only when another load of another release succeeded
            // while this one ran: both runs are recorded, and the newest
            // succeeded one is live. Reported rather than corrected — this
            // stage does not overwrite another run's outcome.
            logger.warn('release_not_active', {
                stage: STAGE,
                release: deps.release,
                runId: run.id,
                activeRelease: active === null ? null : active.releaseId,
                activeRunId: active === null ? null : active.runId,
            });
        }

        return {
            runId: run.id,
            release: deps.release,
            resumed,
            dryRun: false,
            activated,
            counts: { ...state.counts },
            verification: verification.members,
            countChecks,
            retiredSourceKeys,
        };
    } catch (error) {
        await closeFailedRun(deps, run.id, state, error);
        throw error;
    }
};

// ---------------------------------------------------------------------------
// Reporting.
// ---------------------------------------------------------------------------

const gapFields = (gaps: readonly PrerequisiteGap[]): LogFields => {
    const fields: LogFields = { stage: STAGE, gapCount: gaps.length };
    // Several gaps can share a code here — one per missing release file — so the
    // key carries an index after the first, keeping every entry in the line.
    const used = new Set<string>();
    for (const gap of gaps) {
        let key = `gap_${gap.code}`;
        let suffix = 2;
        while (used.has(key)) {
            key = `gap_${gap.code}_${suffix}`;
            suffix += 1;
        }
        used.add(key);
        fields[key] =
            gap.detail === undefined
                ? `${gap.requirement}. ${gap.remedy}`
                : `${gap.requirement}. ${gap.remedy} [${gap.detail}]`;
    }
    return fields;
};

// Every error class this file can observe gets its own reported code; anything
// unrecognised is reported through safeError under `unexpected_error` rather
// than swallowed or printed raw.
export const describeFailure = (error: unknown): { code: string; error: { name: string; message: string } } => {
    // This stage's own refusals first: they are the codes an operator acts on —
    // a digest mismatch means the artefact is not the reviewed one, a count
    // mismatch means the load did not produce what the release promised and the
    // pointer has not moved.
    if (error instanceof CatalogLoadError) {
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

    // Reaching this line means dbGuard already accepted the origin — including,
    // for a non-development one, the --confirm-target it owns.
    const origin = classifyDatabaseOrigin(process.env.DATABASE_URL);
    logger.info('database_origin_accepted', {
        stage: STAGE,
        originClass: origin.originClass,
        host: origin.host,
        database: origin.database,
        reason: origin.reason,
    });
    logger.info('stage_invoked', { stage: STAGE, release: parsed.options.release, dryRun: parsed.options.dryRun });

    const gaps = preflight(defaultPreflightDeps(parsed.options.release));
    if (gaps.length > 0) {
        logger.error('stage_prerequisites_unmet', gapFields(gaps));
        return 1;
    }

    const release = assertReleaseVersion(parsed.options.release);

    // THE LOADER'S STAGE CLAIM. A load MUTATES the catalog graph — it upserts
    // foods, replaces their children and retires rows absent from the release —
    // so everything below runs while this process holds the catalog-graph lock
    // EXCLUSIVELY, and no import, generation, validation or second load can hold
    // it at the same time (lib/checkpoint.ts's THE STAGE LOCK). Whatever lands
    // inside this wrapper inherits that; it is deliberately the outermost thing
    // around the work rather than something the work opts into. It is taken
    // before the Prisma client is even constructed, so a refused lock costs
    // nothing and no write can begin outside it.
    return withCatalogStageLock({ stage: 'release_load', logger }, async () => {
        // Reached here rather than at module load: constructing the client is a side
        // effect, and the suites that read parseArgs, preflight and the pure
        // comparators above must not pay for it — nor must a refused preflight.
        const { prisma } = await import('../src/prisma/client');

        try {
            const summary = await runLoad({
                db: prisma as unknown as LoadDb,
                runDb: prisma,
                release,
                manifest: loadReleaseManifest(release),
                releaseRoot: releaseDir(release),
                logger,
                now: () => new Date(),
                dryRun: parsed.options.dryRun,
            });

            logger.info('stage_completed', {
                stage: STAGE,
                release: summary.release,
                runId: summary.runId,
                dryRun: summary.dryRun,
                resumed: summary.resumed,
                activated: summary.activated,
                counts: JSON.stringify(summary.counts),
                retired: summary.retiredSourceKeys.length,
            });

            return 0;
        } finally {
            // Unconditional, and after the reporting rather than before it: an
            // operator's run must not leave a pooled connection open, and a failed
            // load still has to release it.
            await prisma.$disconnect();
        }
    });
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
