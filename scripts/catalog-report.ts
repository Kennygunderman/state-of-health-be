// Stage 4 of the catalog pipeline: the coverage and quality report.
//
// WHAT THIS STAGE DOES. It reads `catalog_foods` and
// `catalog_validation_records` and writes the two committed evidence artefacts:
//
//   data/meal-planning/reports/latest/validation-report.json
//       one machine-readable record per PUBLISHED food — its identity, the
//       provenance of its nutrition, the portions and the identity evidence
//       behind it, and every check with the value observed and the bound that
//       observation was measured against — plus the three-tier rollup and the
//       per-category quarantine counts over the same rows.
//
//   data/meal-planning/reports/latest/import-report.json
//       the aggregate half only: counts by category, identity source and
//       nutrition provenance, the duplicate and quarantine figures, the
//       coverage gaps, and the EXACT per-category shortfall. Every other field
//       in that file belongs to `catalog:import` and is preserved untouched.
//
// THIS STAGE IS READ-ONLY. It is the evidence stage, and evidence that could
// alter its subject is not evidence. There is no `create`, `update`, `upsert`,
// `delete`, `createMany`, `updateMany`, `executeRaw` or `$transaction` anywhere
// in this file, and {@link ReportDb} — the slice of the client this stage may
// use — declares `findMany` and nothing else, so adding a write is a compile
// error rather than a review miss.
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
// negotiable. The run therefore writes the validation report, reads its
// quarantine block back off disk, compares it with the figures bound for the
// import report, and REFUSES to write the second artefact if they differ,
// naming both numbers. Inconsistent evidence is worse than none: it is wrong
// and it looks authoritative.
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

import { classifyDatabaseOrigin, DatabaseOriginError } from './lib/dbGuard';
import { createFatalLogger, createLogger, safeError, writeLineSync } from './lib/logger';
import type { LogFields, LogLevel, ScriptLogger } from './lib/logger';
import { ManifestError, loadCoveragePlan, loadEvidenceAllowlist, reportPath } from './lib/manifest';
import type { CatalogFoodState, CoveragePlan } from './lib/manifest';

// The decode half of the storage rule `catalog-validate` writes under:
// `nutrition_assumptions` is a JSON-encoded array in a TEXT column. Imported
// rather than re-implemented, because a second decoder is a second rule that
// can drift from the encoder while still parsing.
import { parseStoredAssumptions } from './catalog-validate';

// The RULES this report applies, none of them re-derived here: the shortfall
// arithmetic, the tier every check name carries, and the bound a category and
// food state resolve to (Rule backend-architecture §1.2 and §7 — pure
// functions decide, the aggregation loop and the file writing orchestrate).
import {
    CATALOG_QUARANTINE_CHECK_NAMES,
    CATALOG_REJECT_CHECK_NAMES,
    CATALOG_REVIEW_CHECK_NAMES,
    catalogCheckTier,
    computeCoverageShortfall,
    resolveCategoryBounds,
} from '../src/services/catalog.logic';
import type { CatalogCheckName, CatalogCoverageShortfall, CatalogValidationPolicy } from '../src/services/catalog.logic';

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

/** The publication status whose rows carry the per-item evidence records. */
const PUBLISHED = 'published';
const QUARANTINED = 'quarantined';
const REJECTED = 'rejected';

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
    | 'report_unreadable';

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
        '                     catalog. A scoped report is partial evidence, so it also',
        '                     requires --out and will not overwrite the committed',
        '                     full-catalog artefacts.',
        '  --out <dir>        Write the artefacts to this directory instead of the',
        '                     default. A relative path resolves against the backend',
        '                     package root.',
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

const sortedRecord = <T>(record: Readonly<Record<string, T>>): Record<string, T> => {
    const sorted: Record<string, T> = {};
    for (const key of Object.keys(record).sort(compareStrings)) {
        sorted[key] = record[key];
    }
    return sorted;
};

const increment = (record: Record<string, number>, key: string, by = 1): void => {
    record[key] = (record[key] ?? 0) + by;
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
    const camelized: Record<string, unknown> = {};
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
    readonly publication_status: string;
    readonly food_group: string;
    readonly usda_data_type: string | null;
    readonly catalog_validation_records: ValidationRecordRow | null;
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
    publication_status: true,
    food_group: true,
    usda_data_type: true,
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
    readonly failingChecks: readonly string[];
}

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
    readonly quarantinedByCheck: Record<string, number>;
    readonly quarantinedByCategory: Record<string, number>;
    readonly rejectedByCheck: Record<string, number>;
    readonly quarantinedIdentities: readonly QuarantinedIdentity[];
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
}

interface FailingCheckSummary {
    readonly names: readonly string[];
    readonly entries: number;
    readonly passed: number;
    readonly byTier: Readonly<Record<string, number>>;
}

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
    const byTier: Record<string, number> = {};
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
        if (tier !== null) {
            increment(byTier, tier);
        }
    }

    return { names, entries, passed, byTier };
};

const emptyCategoryMeasurement = (): CategoryMeasurement => ({
    byPublicationStatus: {},
    publishedFoodStates: {},
    publishedReviewFailuresByCheck: {},
    publishedItemsWithRejectFailure: 0,
    publishedItemsWithQuarantineFailure: 0,
    publishedItemsWithReviewFailure: 0,
    quarantinedByCheck: {},
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
    const byPublicationStatus: Record<string, number> = {};
    const categories: Record<string, CategoryMeasurement> = {};
    const publishedByCategory: Record<string, number> = {};
    const publishedByIdentitySource: Record<string, number> = {};
    const publishedByIdentityStatus: Record<string, number> = {};
    const publishedByNutritionProvenance: Record<string, number> = {};
    const publishedByNutritionMethod: Record<string, number> = {};
    const publishedByNutritionBasis: Record<string, number> = {};
    const publishedByUsdaDataType: Record<string, number> = {};
    const publishedByOutcome: Record<string, number> = {};
    const publishedByFoodState: Record<string, number> = {};
    const publishedChecks: Record<string, CheckTally> = {};
    const unrecognisedCheckNames: Record<string, number> = {};
    const quarantinedByCheck: Record<string, number> = {};
    const quarantinedByCategory: Record<string, number> = {};
    const rejectedByCheck: Record<string, number> = {};
    const publishedEvidenceRecordsPerItem: Record<string, number> = {};
    const quarantinedIdentities: QuarantinedIdentity[] = [];
    const publishedWithoutValidationRecord: string[] = [];
    const publishedIdentities = new Map<string, string[]>();
    const recordFieldMismatches: RecordFieldMismatch[] = [];

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

    const categoryOf = (category: string): CategoryMeasurement => {
        const existing = categories[category];
        if (existing !== undefined) {
            return existing;
        }
        const created = emptyCategoryMeasurement();
        categories[category] = created;
        return created;
    };

    await forEachFoodPage(db, where, (rows) => {
        for (const row of rows) {
            rowsScanned += 1;
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
                    const tally = publishedChecks[check.name] ?? {
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

            if (row.publication_status === QUARANTINED) {
                increment(quarantinedByCategory, row.category);
                const summary = summarizeChecks(record === null ? null : record.checks, unrecognisedCheckNames);
                for (const name of summary.names) {
                    increment(quarantinedByCheck, name);
                    increment(category.quarantinedByCheck, name);
                }
                quarantinedIdentities.push({
                    sourceKey: row.source_key,
                    category: row.category,
                    foodState: row.food_state,
                    displayName: row.display_name,
                    identitySource: row.identity_source,
                    outcome: record === null ? null : record.outcome,
                    failingChecks: [...summary.names].sort(compareStrings),
                });
                continue;
            }

            if (row.publication_status === REJECTED) {
                const summary = summarizeChecks(record === null ? null : record.checks, unrecognisedCheckNames);
                for (const name of summary.names) {
                    increment(rejectedByCheck, name);
                }
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
        quarantinedByCheck,
        quarantinedByCategory,
        rejectedByCheck,
        quarantinedIdentities: quarantinedIdentities.sort((left, right) => compareStrings(left.sourceKey, right.sourceKey)),
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
    readonly quarantined: number;
    readonly candidate: number;
    readonly rejected: number;
    readonly retired: number;
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

const statusCount = (row: Readonly<Record<string, number>>, status: string): number => row[status] ?? 0;

export const buildCoverageRows = (
    policy: CatalogValidationPolicy,
    plan: CoveragePlan,
    measurement: CatalogMeasurement,
    shortfall: CatalogCoverageShortfall,
): readonly CoverageRow[] => {
    const rows = shortfall.categories.map((entry): CoverageRow => {
        const planCategory = plan.categories.find((candidate) => candidate.category === entry.category);
        const category = measurement.categories[entry.category] ?? emptyCategoryMeasurement();
        const bounds = resolveCategoryBounds(policy, entry.category, 'raw' as CatalogFoodState);

        // What the observations in this category were actually measured
        // against, resolved per food state the category holds rather than
        // assumed: `grain` and `legume` override the category-wide band for
        // their dry and cooked forms, and `resolveCategoryBounds` is the rule
        // that decides which band applies.
        const byFoodState: Record<
            string,
            { min: number; max: number; fromFoodStateOverride: boolean }
        > = {};
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

        return {
            category: entry.category,
            publishedTarget: entry.publishedTarget,
            candidateVolume: planCategory === undefined ? null : planCategory.candidateVolume,
            published: entry.published,
            shortfall: entry.shortfall,
            quarantined: statusCount(category.byPublicationStatus, QUARANTINED),
            candidate: statusCount(category.byPublicationStatus, 'candidate'),
            rejected: statusCount(category.byPublicationStatus, REJECTED),
            retired: statusCount(category.byPublicationStatus, 'retired'),
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
    const perCategory: Record<string, number> = {};
    for (const row of rows) {
        perCategory[row.category] = row.quarantined;
    }
    for (const [category, count] of Object.entries(measurement.quarantinedByCategory)) {
        perCategory[category] = count;
    }
    return sortedRecord(perCategory);
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
    readonly unmetRequirements: readonly { readonly code: string; readonly detail: string }[];
    readonly verdict: string;
}

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
    if (shortfall.shortfallTotal > 0) {
        unmetRequirements.push({
            code: 'categories_below_published_target',
            detail:
                `${formatCount(categoriesBelowTarget)} categories short of their publishedTarget by ` +
                `${formatCount(shortfall.shortfallTotal)} items in total; the per-category figures are in categories[].`,
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
    const merged: Record<string, unknown> = { ...(asRecord(existing) ?? {}) };
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
        const tally = measurement.publishedChecks[name];
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
        .filter((name) => (measurement.publishedChecks[name]?.evaluated ?? 0) === 0)
        .sort(compareStrings);

    const planQuarantineChecks = [...plan.quarantineChecks].sort(compareStrings);
    const derivedQuarantineChecks = [...CATALOG_QUARANTINE_CHECK_NAMES].sort(compareStrings);

    return {
        source: CHECK_VOCABULARY_SOURCE,
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
            'Which checks a run records is a property of that run, not of this aggregate: a name recorded on no ' +
            'published item is reported as such and no reason is inferred for it.',
        unrecognisedCheckNames: sortedRecord(measurement.unrecognisedCheckNames),
        unrecognisedCheckNamesNote:
            'Check names found on a record that the vocabulary does not declare. They are counted and named rather ' +
            'than filed under a guessed tier, because a tier decides a row\u2019s disposition.',
    };
};

const buildBoundsBlock = (plan: CoveragePlan): unknown => {
    const kcalReviewRangeByCategory: Record<string, unknown> = {};
    const energyMacroTolerancePercentByCategory: Record<string, number> = {};
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
];

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
        const byCheck: Record<string, number> = {};
        for (const [name, tally] of Object.entries(measurement.publishedChecks)) {
            if (tally.tier === tier && tally.failed > 0) {
                byCheck[name] = tally.failed;
            }
        }
        return sortedRecord(byCheck);
    };

    const itemsWithTierFailure = (pick: (category: CategoryMeasurement) => number): number =>
        Object.values(measurement.categories).reduce((total, category) => total + pick(category), 0);

    const checksByCheck: Record<string, unknown> = {};
    for (const [name, tally] of Object.entries(measurement.publishedChecks)) {
        checksByCheck[name] = { tier: tally.tier, evaluated: tally.evaluated, passed: tally.passed, failed: tally.failed };
    }

    const entries: OwnedEntries = [
        ['reportVersion', REPORT_VERSION],
        ['reportKind', VALIDATION_REPORT_KIND],
        [
            'purpose',
            'Acceptance evidence that every published catalog food carries a machine-readable validation record, with ' +
                'the observed value and the bound it was measured against for every check. This artefact records what ' +
                `was measured; the bounds, tiers and category targets it measures against are owned by ` +
                `${COVERAGE_PLAN_RELATIVE_PATH} and are cited, not restated as policy here.`,
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
                whyTheShortfallStaysTruthful:
                    'A quarantined record is never published on an invented value, so it is excluded from every ' +
                    'published count and from the coverage figures. That is what makes the per-category shortfall the ' +
                    'honest distance to the plan rather than a number inflated by unusable rows.',
            },
        ],
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
                    field: 'per-item records for quarantined, rejected, candidate and retired rows',
                    value: null,
                    reason:
                        'This artefact carries per-item evidence for published rows. The quarantined identities and ' +
                        'their failing checks are named in the quarantine block; rejected and candidate rows are ' +
                        'counted by category and by check, and the stage that judged them evidences them in the ' +
                        'import report.',
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
    const projected: Record<string, unknown> = {};
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

const subObjectOf = (existing: Readonly<Record<string, unknown>> | null, key: string): Record<string, unknown> =>
    existing === null ? {} : { ...(asRecord(existing[key]) ?? {}) };

const mergeSubObject = (
    existing: Readonly<Record<string, unknown>> | null,
    key: string,
    own: Readonly<Record<string, unknown>>,
): Record<string, unknown> => {
    const merged = subObjectOf(existing, key);
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
    readonly validationReportRelativePath: string;
    readonly scopedTo: string | null;
    readonly existing: Readonly<Record<string, unknown>> | null;
}): OwnedEntries => {
    const { measurement, shortfall, rows, requirement, quarantine, existing, scopedTo } = input;

    const failuresOverStatus = (byCheck: Readonly<Record<string, number>>): Record<string, unknown> => {
        const byTier: Record<string, Record<string, number>> = { reject: {}, quarantine: {}, review: {}, unrecognised: {} };
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

    const publishedFailures: Record<string, number> = {};
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
                // Set to null because this stage supplies the identities: a
                // preserved sentence saying they are unavailable would be a
                // claim the data beside it contradicts.
                identitiesUnavailableReason: null,
                measuredFrom:
                    'catalog_foods.publication_status = quarantined, joined to catalog_validation_records for the ' +
                    'failing checks. Both the per-category split and the identities exist only in those tables, which ' +
                    'is why a report derived from the committed release artefacts states them as unmeasured.',
                note:
                    'A quarantined record is never published on an invented value, so it counts toward no published ' +
                    'figure and toward no target. That is what keeps the shortfall truthful.',
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
                    shortfallTotal: shortfall.shortfallTotal,
                    quarantineTotal: quarantine.total,
                    quarantinePerCategoryAgrees: true,
                    agreementNote:
                        'Both artefacts were written from one scan, and the quarantine figures in this file were ' +
                        'compared against the block read back off the validation report before this file was ' +
                        'written. A disagreement ends the run instead of producing two reports that cannot both be ' +
                        'right.',
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
                    field: 'reject-tier per-item evidence',
                    value: null,
                    reason:
                        'A rejected row carries a validation record and is counted here by the check that ' +
                        'disqualified it, but per-item evidence in the validation report covers published rows, ' +
                        'which is what the catalog serves.',
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
}

export type OpenSink = (absolutePath: string) => ReportSink;

export interface ReportIo {
    readonly openSink: OpenSink;
    /**
     * The artefact's fields WITHOUT its `items` map, or `null` when the file
     * does not exist.
     *
     * Bounded on purpose: a full validation report is far too large to parse to
     * preserve a header out of, so the read stops at the `items` key and parses
     * the prefix. A file with no `items` key — the import report — is parsed
     * whole.
     */
    readonly readHeaderObject: (absolutePath: string) => Record<string, unknown> | null;
    readonly writeJsonObject: (absolutePath: string, value: Readonly<Record<string, unknown>>) => void;
}

/** Generous beside a header of a few tens of kilobytes, and small enough that
 * the bound is what stops a runaway read rather than available memory. */
const HEADER_READ_LIMIT_BYTES = 4 * 1024 * 1024;

const openFileSink = (absolutePath: string): ReportSink => {
    fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
    const stream = fs.createWriteStream(absolutePath, { encoding: 'utf-8' });

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
        },
    };
};

const parseHeaderText = (text: string, absolutePath: string): Record<string, unknown> => {
    let parsed: unknown;
    try {
        parsed = JSON.parse(text);
    } catch (error) {
        throw new CatalogReportError(
            `${absolutePath} is not readable as JSON, so the fields it already carries cannot be preserved: ` +
                `${safeError(error).message}. Move or repair the file and run again.`,
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

const readHeaderObjectFromFile = (absolutePath: string): Record<string, unknown> | null => {
    if (!fs.existsSync(absolutePath)) {
        return null;
    }

    const size = fs.statSync(absolutePath).size;
    const readLength = Math.min(size, HEADER_READ_LIMIT_BYTES);
    const buffer = Buffer.alloc(readLength);
    const descriptor = fs.openSync(absolutePath, 'r');
    try {
        fs.readSync(descriptor, buffer, 0, readLength, 0);
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

export const defaultReportIo = (): ReportIo => ({
    openSink: openFileSink,
    readHeaderObject: readHeaderObjectFromFile,
    writeJsonObject: (absolutePath, value): void => {
        fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
        fs.writeFileSync(absolutePath, `${JSON.stringify(value, null, 2)}\n`, 'utf-8');
    },
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
    const merged: Record<string, unknown> = { ...(existing ?? {}) };
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
    const numbers: Record<string, number> = {};
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
        const onDisk = input.onDisk.perCategory[category];
        const measured = input.measured.perCategory[category];
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
            `${input.importReportPath}, so one of the two artefacts is wrong and ${IMPORT_REPORT_FILE} was not ` +
            `written: ${disagreements.join('; ')}.`,
        'quarantine_reconciliation_failed',
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
    readonly outDir: string;
    readonly logger: ScriptLogger;
    readonly io: ReportIo;
}

export interface ReportOutcome {
    readonly validationReportPath: string;
    readonly importReportPath: string;
    readonly rowsScanned: number;
    readonly publishedItems: number;
    readonly itemRecords: number;
    readonly quarantined: number;
    readonly shortfallTotal: number;
    readonly requirementMet: boolean;
    readonly unmetRequirements: readonly string[];
}

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

    const shortfall = computeCoverageShortfall(policy, measurement.publishedByCategory);
    const rows = buildCoverageRows(policy, plan, measurement, shortfall);
    const requirement = buildRequirementBlock({ plan, measurement, shortfall, rows, scopedTo });
    const quarantine: QuarantineFigures = {
        total: statusCount(measurement.byPublicationStatus, QUARANTINED),
        perCategory: quarantinePerCategory(rows, measurement),
    };

    const validationReportPath = path.join(outDir, VALIDATION_REPORT_FILE);
    const importReportPath = path.join(outDir, IMPORT_REPORT_FILE);

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

    const { itemCount } = await writeValidationReport({
        sink: io.openSink(validationReportPath),
        existing: existingValidationReport,
        entries: validationEntries,
        emitItems: async (emit) => {
            await forEachFoodPage(db, { ...where, publication_status: PUBLISHED }, async (page) => {
                for (const row of page) {
                    const record = row.catalog_validation_records;
                    if (record === null) {
                        continue;
                    }
                    await emit(row.source_key, toItemRecord(row, record));
                }
            });
        },
    });
    runLogger.info('validation_report_written', { stage: STAGE, path: validationReportPath, itemRecords: itemCount });

    // Read back from disk, not from the object just built: what the next stage
    // and the next reviewer will read is the file, and only the file can show
    // that what this run measured is what actually landed.
    reconcileQuarantineFigures({
        validationReportPath,
        importReportPath,
        onDisk: quarantineFiguresOf(io.readHeaderObject(validationReportPath), validationReportPath),
        measured: quarantine,
    });

    const existingImportReport = io.readHeaderObject(importReportPath);
    io.writeJsonObject(
        importReportPath,
        mergeOwnedFields(
            existingImportReport,
            buildImportReportEntries({
                measurement,
                shortfall,
                rows,
                requirement,
                quarantine,
                validationReportRelativePath: `data/meal-planning/reports/latest/${VALIDATION_REPORT_FILE}`,
                scopedTo,
                existing: existingImportReport,
            }),
        ),
    );
    runLogger.info('import_report_merged', { stage: STAGE, path: importReportPath });

    return {
        validationReportPath,
        importReportPath,
        rowsScanned: measurement.rowsScanned,
        publishedItems: shortfall.publishedTotal,
        itemRecords: itemCount,
        quarantined: quarantine.total,
        shortfallTotal: shortfall.shortfallTotal,
        requirementMet: requirement.requirementMet,
        unmetRequirements: requirement.unmetRequirements.map((entry) => entry.code),
    };
};

// ---------------------------------------------------------------------------
// Reporting.
// ---------------------------------------------------------------------------

// Every error class this file can observe gets its own reported code; anything
// unrecognised is reported through safeError under `unexpected_error` rather
// than swallowed or printed raw (Rule backend-architecture §8).
const describeFailure = (error: unknown): { code: string; error: { name: string; message: string } } => {
    if (error instanceof CatalogReportError) {
        return { code: error.code, error: safeError(error) };
    }
    if (error instanceof DatabaseOriginError) {
        return { code: error.code, error: safeError(error) };
    }
    if (error instanceof ManifestError) {
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
 * Exit codes say whether EVIDENCE WAS PRODUCED, not whether the evidence is
 * good news: 0 means both artefacts were written and reconciled, 1 means they
 * were not. An unmet requirement is a successfully measured finding — it is
 * stated in `requirement.unmetRequirements` and logged as `requirement_unmet`
 * — and conflating it with a failed run would leave an operator unable to tell
 * a shortfall from a missing report.
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
        originClass: origin.originClass,
        host: origin.host,
        database: origin.database,
        reason: origin.reason,
    });

    const plan = loadCoveragePlan();
    const allowlist = loadEvidenceAllowlist();

    const scopedTo = parsed.options.category;
    if (scopedTo !== null) {
        if (!plan.categories.some((entry) => entry.category === scopedTo)) {
            throw new CatalogReportError(
                `--category ${scopedTo} is not a category ${COVERAGE_PLAN_RELATIVE_PATH} declares. It declares: ` +
                    `${plan.categories.map((entry) => entry.category).sort(compareStrings).join(', ')}.`,
                'unknown_category_filter',
            );
        }
        // A scoped run measures part of the catalog, and partial evidence must
        // never take the place of the committed whole-catalog artefacts — which
        // is exactly what writing it to the default directory would do.
        if (parsed.options.out === null) {
            throw new CatalogReportError(
                `--category ${scopedTo} produces partial evidence, so it also requires --out <dir>: writing it to ` +
                    'the default report directory would replace the whole-catalog artefacts with a single ' +
                    "category's figures.",
                'scoped_report_needs_out_dir',
            );
        }
    }

    const outDir = resolveOutDir(parsed.options.out);
    logger.info('stage_invoked', { stage: STAGE, outDir, categoryFilter: scopedTo });

    // HERE rather than at module load: `src/prisma/client.ts` constructs the
    // client at import time, so importing this module for its exported
    // functions must not reach it (Rule backend-architecture §10, §11).
    const { prisma } = await import('../src/prisma/client');

    try {
        const outcome = await runReport({
            db: prisma as unknown as ReportDb,
            plan,
            allowlistVersion: allowlist.allowlistVersion,
            evidenceRegistrySnapshot: allowlist.registrySnapshot,
            options: parsed.options,
            outDir,
            logger,
            io: defaultReportIo(),
        });

        if (outcome.unmetRequirements.length > 0) {
            logger.warn('requirement_unmet', requirementFields(outcome));
        }

        logger.info('stage_completed', {
            stage: STAGE,
            rowsScanned: outcome.rowsScanned,
            publishedItems: outcome.publishedItems,
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
