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
import { ManifestError, assertReleaseVersion, loadCoveragePlan, releaseDir } from './lib/manifest';
import type { CoveragePlan } from './lib/manifest';
import { ModelBudgetError } from './lib/budget';
import { RateLimitConfigError } from './lib/rateLimiter';
import { CheckpointError } from './lib/checkpoint';
import type { ScriptLogger } from './lib/logger';
import { assessComponentCoverage } from '../src/services/catalog.logic';
import crypto from 'crypto';

const STAGE = 'catalog-release';

const CATALOG_LOGIC_MODULE = 'src/services/catalog.logic.ts';

const RELEASE_FLAG = '--release';

const logger = createLogger(STAGE);

// ---------------------------------------------------------------------------
// Argument parsing — pure (Rule backend-architecture §1.2).
// ---------------------------------------------------------------------------

export interface ReleaseOptions {
    readonly help: boolean;
    /** The release id exactly as the operator typed it; validated in preflight. */
    readonly release: string;
    readonly force: boolean;
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
        return { ok: true, options: { help: true, release: '', force: false } };
    }

    const errors: ArgumentError[] = [];
    let release: string | null = null;
    let releaseSeen = false;
    let force = false;

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
        errors.push({ flag: RELEASE_FLAG, message: `${RELEASE_FLAG} is required; name the release to write, such as v1` });
    }

    if (errors.length > 0) {
        return { ok: false, errors };
    }

    return { ok: true, options: { help: false, release: release === null ? '' : release, force } };
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

const defaultPreflightDeps = (release: string, force: boolean): ReleasePreflightDeps => ({
    env: process.env,
    release,
    force,
    loadCoveragePlan,
    assertReleaseVersion,
    releaseDir,
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
                remedy: `Choose the next release id, or pass --force to overwrite data/meal-planning/catalog/releases/${deps.release}.`,
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
    readonly catalog_generation_batches: { readonly batch_key: string } | null;
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

export interface ReleaseDb {
    catalog_foods: { findMany(args: unknown): Promise<ReleaseFoodRow[]> };
    catalog_import_runs: {
        create(args: unknown): Promise<{ id: string }>;
        /** Read to prove the published set is a validated set and not a mid-pipeline one. */
        findMany(args: unknown): Promise<ReleaseRunRow[]>;
    };
}

/** The slice of a pipeline run this stage reads to check its prerequisite order. */
export interface ReleaseRunRow {
    readonly kind: string;
    readonly manifest_version: string;
    readonly status: string;
    readonly finished_at: Date | null;
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

/** JSONL: one compact object per line, LF-terminated including the last. */
const toJsonl = (rows: readonly Record<string, unknown>[]): string =>
    rows.length === 0 ? '' : `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`;

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

    const rows = await deps.db.catalog_foods.findMany({
        where: { publication_status: 'published' },
        orderBy: { source_key: 'asc' },
        select: {
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
            catalog_generation_batches: { select: { batch_key: true } },
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
        },
    });

    const foods: Record<string, unknown>[] = [];
    const aliases: Record<string, unknown>[] = [];
    const portions: Record<string, unknown>[] = [];
    const components: Record<string, unknown>[] = [];
    const validationRecords: Record<string, unknown>[] = [];
    const withoutValidationRecord: string[] = [];
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

    for (const row of rows) {
        foods.push(toReleaseFoodLine(row));
        publishedByCategory[row.category] = (publishedByCategory[row.category] ?? 0) + 1;

        if (row.usda_data_type !== null && row.source_version !== null) {
            const seen = sourceVersions.get(row.usda_data_type) ?? new Set<string>();
            seen.add(row.source_version);
            sourceVersions.set(row.usda_data_type, seen);
            const latest = retrievedAt.get(row.usda_data_type);
            if (row.imported_at !== null && (latest === undefined || row.imported_at > latest)) {
                retrievedAt.set(row.usda_data_type, row.imported_at);
            }
        }

        for (const { alias } of row.catalog_food_aliases) {
            aliases.push({ food_source_key: row.source_key, alias: alias.toLowerCase() });
        }
        for (const portion of row.catalog_food_portions) {
            portions.push({
                food_source_key: row.source_key,
                description: portion.description,
                amount: portion.amount,
                unit: portion.unit,
                gram_weight: portion.gram_weight,
                is_default: portion.is_default,
                source: portion.source,
            });
        }
        for (const component of row.catalog_food_components) {
            if (component.component_catalog_foods === null) {
                continue;
            }
            components.push({
                food_source_key: row.source_key,
                // The portable reference, never the local uuid: a component id
                // means nothing in another database.
                component_food_source_key: component.component_catalog_foods.source_key,
                quantity_grams: component.quantity_grams,
                yield_factor: component.yield_factor,
                component_nutrition_version: component.component_nutrition_version,
                sort_order: component.sort_order,
            });
        }

        const validation = toReleaseValidationLine(row);
        if (validation === null) {
            withoutValidationRecord.push(row.source_key);
        } else {
            validationRecords.push(validation);
        }
    }

    // The published set is only meaningful if validation was the last thing to
    // decide it. An import writes every record it touches back as a candidate —
    // it deliberately never publishes — so an import that finished after the
    // last validation leaves the foods it touched unpublished, and exporting
    // then yields a quietly smaller release that still passes every internal
    // check. It is a snapshot of a pipeline halfway through, and the only
    // symptom is a count nobody was watching. Refused instead, with the order
    // to run.
    const staleReason = releaseStalenessReason(await loadPipelineRuns(deps.db), deps.logger);
    if (staleReason !== null) {
        throw new ReleaseIntegrityError(staleReason);
    }

    if (withoutValidationRecord.length > 0) {
        // Every published food must carry a validation record: it is the
        // machine-readable evidence the feature requires, and a release short
        // of one is not a release. Refused rather than written incomplete.
        throw new ReleaseIntegrityError(
            `${withoutValidationRecord.length} published food(s) carry no validation record, so the release would ship unevidenced rows: ${withoutValidationRecord
                .slice(0, 5)
                .join(', ')}${withoutValidationRecord.length > 5 ? ', …' : ''}. Run catalog:validate before catalog:release.`,
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
    // This function decides nothing: it maps rows onto the facts the rule
    // reads, and turns a refusal into the operator's next command.
    const componentCoverage = assessComponentCoverage(
        rows.map((row) => ({
            source_key: row.source_key,
            nutrition_provenance: row.nutrition_provenance,
            // Only components that RESOLVE to a food count: a row pointing at a
            // food this release does not carry is not something a nutrient
            // total could have been derived from.
            resolvable_component_count: row.catalog_food_components.filter(
                (component) => component.component_catalog_foods !== null,
            ).length,
        })),
    );
    if (!componentCoverage.ok) {
        const missing = componentCoverage.derivedWithoutComponents;
        throw new ReleaseIntegrityError(
            `${missing.length} published food(s) declare nutrition_provenance 'ingredient_derived' but carry no component rows, so their nutrient totals have no stored composition to derive from: ${missing
                .slice(0, 5)
                .join(', ')}${missing.length > 5 ? ', …' : ''}. Run catalog:validate before catalog:release.`,
        );
    }
    logger.info('components_asserted', {
        components: components.length,
        published_ingredient_derived: componentCoverage.derivedCount,
    });

    // Sorted by (parent, child) so the file is byte-reproducible whatever order
    // the database returned the parents' children in.
    const bySourceKeyThen = (secondKey: string) => (left: Record<string, unknown>, right: Record<string, unknown>): number => {
        const leftParent = String(left.food_source_key);
        const rightParent = String(right.food_source_key);
        if (leftParent !== rightParent) {
            return leftParent < rightParent ? -1 : 1;
        }
        const leftChild = String(left[secondKey]);
        const rightChild = String(right[secondKey]);
        return leftChild < rightChild ? -1 : leftChild > rightChild ? 1 : 0;
    };
    aliases.sort(bySourceKeyThen('alias'));
    portions.sort(bySourceKeyThen('description'));
    components.sort(bySourceKeyThen('component_food_source_key'));

    const directory = deps.releaseDir(deps.release);
    deps.ensureDir(directory);

    const contents: Readonly<Record<string, string>> = {
        'foods.jsonl': toJsonl(foods),
        'aliases.jsonl': toJsonl(aliases),
        'portions.jsonl': toJsonl(portions),
        // Empty when no food has a derived composition, which is the case for a
        // release built entirely from source-backed single-ingredient records.
        // The file is still written: the six-file contract requires it to exist
        // so the loader verifies six digests, and the manifest records its
        // digest, row count and size, which is what makes an empty member an
        // asserted empty set rather than an absent file. Inventing a
        // composition to fill it would fabricate a nutrient total.
        'components.jsonl': toJsonl(components),
        'validation-records.jsonl': toJsonl(validationRecords),
    };

    const rowCounts: Readonly<Record<string, number>> = {
        'foods.jsonl': foods.length,
        'aliases.jsonl': aliases.length,
        'portions.jsonl': portions.length,
        'components.jsonl': components.length,
        'validation-records.jsonl': validationRecords.length,
    };

    for (const fileName of RELEASE_DATA_FILES) {
        deps.writeFile(path.join(directory, fileName), contents[fileName]);
    }

    // Measured from the bytes on disk, not from the strings above: the manifest
    // has to describe the file a loader will actually read, and a digest taken
    // from memory would not catch a write that failed halfway.
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

    const byCategory = coveragePlan.categories.map((category) => {
        const published = publishedByCategory[category.category] ?? 0;
        return {
            category: category.category,
            published,
            // The same count under the name the release format contract uses,
            // written alongside so neither reader has to know the other's
            // spelling — the convention `path`/`name` and
            // `categories`/`by_category` already follow.
            published_actual: published,
            published_target: category.publishedTarget,
            shortfall: Math.max(0, category.publishedTarget - published),
        };
    });
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
    const shortfallTotal = byCategory.reduce((total, category) => total + category.shortfall, 0);
    const publishedGapToTotal = Math.max(0, coveragePlan.publishedTargetTotal - foods.length);

    const manifest = {
        release_id: deps.release,
        manifest_version: 'v1',
        coverage_plan_version: coveragePlan.coveragePlanVersion,
        generated_at: generatedAt.toISOString(),
        produced_by: 'pipeline',
        files,
        counts: {
            foods: foods.length,
            // Every exported food is published — the query selects on that
            // status — so the two spellings are the same measurement, and both
            // are written for the same reason `path` and `name` are.
            published_foods: foods.length,
            aliases: aliases.length,
            portions: portions.length,
            components: components.length,
            // Written beside `components` so the component count is readable on
            // its own terms: a composition belongs to an ingredient-derived
            // food, so zero components is a fact about this release's
            // composition rather than a gap. Taken from the SAME verdict the
            // invariant above was checked with, which is what makes "the two
            // can never disagree" structural instead of a promise — two
            // independent counts of one thing are exactly how a manifest starts
            // describing a release nobody checked.
            published_ingredient_derived: componentCoverage.derivedCount,
            validation_records: validationRecords.length,
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
        // Null throughout, and meaningfully so: no row in this release was
        // generated or reviewed by a model, so naming one would misattribute
        // every food in it.
        model_versions: {
            generation_model: null,
            review_model: null,
            prompt_version: null,
            // `prompt_version` under the release format contract's spelling,
            // which pairs it with the review prompt it sits beside.
            generation_prompt_version: null,
            review_prompt_version: null,
        },
        coverage: {
            coverage_plan_version: coveragePlan.coveragePlanVersion,
            published_target_total: coveragePlan.publishedTargetTotal,
            published_actual_total: foods.length,
            published_total: foods.length,
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
        foods: foods.length,
        aliases: aliases.length,
        portions: portions.length,
        components: components.length,
        validationRecords: validationRecords.length,
        shortfallTotal,
    });

    // The run row is written directly rather than through checkpoint.ts, whose
    // kind union covers the four stages that resume. This export does not
    // resume — it is one read and six writes — and the row exists for the audit
    // trail, under the kind prisma/schema.prisma documents for it.
    await deps.db.catalog_import_runs.create({
        data: {
            kind: 'release',
            manifest_version: deps.release,
            started_at: generatedAt,
            finished_at: deps.now(),
            status: 'succeeded',
            cursor: { release: deps.release },
            counts: {
                foods: foods.length,
                aliases: aliases.length,
                portions: portions.length,
                components: components.length,
                validation_records: validationRecords.length,
            },
            log: [{ event: 'release_written', at: generatedAt.toISOString(), release: deps.release }],
        },
    });

    return {
        release: deps.release,
        publishedFoods: foods.length,
        counts: {
            foods: foods.length,
            aliases: aliases.length,
            portions: portions.length,
            components: components.length,
            validationRecords: validationRecords.length,
        },
        shortfallTotal,
    };
};

/** A release that would ship incomplete. Reported, never written. */
/** Every finished pipeline run, newest last, for the prerequisite-order check. */
const loadPipelineRuns = async (db: ReleaseDb): Promise<ReleaseRunRow[]> =>
    db.catalog_import_runs.findMany({
        where: { kind: { in: ['usda_import', 'ai_generation', 'validation'] }, status: 'succeeded' },
        select: { kind: true, manifest_version: true, status: true, finished_at: true },
        orderBy: { finished_at: 'asc' },
    });

/**
 * Why this database is not ready to be released, or `null` when it is.
 *
 * Pure over the run rows so the rule is testable without a database. A run
 * whose `finished_at` is null never finished and says nothing about order, so
 * it is ignored rather than treated as the newest.
 */
export const releaseStalenessReason = (runs: readonly ReleaseRunRow[], logger: ScriptLogger): string | null => {
    const latest = (kinds: readonly string[]): ReleaseRunRow | null =>
        runs
            .filter((run) => kinds.includes(run.kind) && run.finished_at !== null)
            .reduce<ReleaseRunRow | null>(
                (newest, run) =>
                    newest === null || (run.finished_at as Date).getTime() > (newest.finished_at as Date).getTime()
                        ? run
                        : newest,
                null,
            );

    const validation = latest(['validation']);
    if (validation === null) {
        return 'no successful catalog:validate run is on record, so no food in this database has been judged. Run catalog:validate before catalog:release.';
    }

    const ingest = latest(['usda_import', 'ai_generation']);
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
        `a ${ingest.kind} run for ${ingest.manifest_version} finished at ${ingestAt.toISOString()}, after the last ` +
        `successful validation at ${validatedAt.toISOString()}. An ingest writes the records it touches back as ` +
        'candidates, so those foods are unpublished right now and this release would silently omit them. ' +
        'Run catalog:validate, then catalog:release.'
    );
};

export class ReleaseIntegrityError extends Error {
    public readonly code = 'release_integrity_failed';

    public constructor(message: string) {
        super(message);
        this.name = 'ReleaseIntegrityError';
    }
}

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
    if (error instanceof ReleaseIntegrityError) {
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
    logger.info('stage_invoked', { stage: STAGE, release: parsed.options.release, force: parsed.options.force });

    const gaps = preflight(defaultPreflightDeps(parsed.options.release, parsed.options.force));
    if (gaps.length > 0) {
        logger.error('stage_prerequisites_unmet', gapFields(gaps));
        return 1;
    }

    // Reached here rather than at module load: constructing the client is a
    // side effect, and the suites that read parseArgs, preflight and the pure
    // serialisers above must not pay for it.
    const { prisma } = await import('../src/prisma/client');

    const outcome = await runRelease({
        db: prisma as unknown as ReleaseDb,
        coveragePlan: loadCoveragePlan(),
        release: assertReleaseVersion(parsed.options.release),
        logger,
        now: () => new Date(),
        releaseDir,
        writeFile: (absolutePath, contents) => {
            fs.writeFileSync(absolutePath, contents, 'utf-8');
        },
        readFileBytes: (absolutePath) => fs.readFileSync(absolutePath),
        ensureDir: (absolutePath) => {
            fs.mkdirSync(absolutePath, { recursive: true });
        },
    });

    logger.info('stage_completed', {
        stage: STAGE,
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
