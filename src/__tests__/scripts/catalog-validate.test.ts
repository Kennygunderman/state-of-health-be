/**
 * The validation stage's unit of work, its resume accounting and its log
 * volume.
 *
 * WHAT THIS FILE IS FOR. `catalog-validate.ts` is the only stage that
 * PUBLISHES, so what it leaves behind when it is interrupted is not a
 * bookkeeping detail: a food judged with no cursor to say so is re-judged and
 * gains a second history entry, and a counter recorded for a judgement that
 * rolled back leaves the run row claiming work the tables do not hold. The
 * stage answers both by making one food ONE unit of work — its judgement, its
 * count delta, its cursor position and, for a row it could not judge, its
 * run-log entry, all in a single transaction — and by carrying the report's
 * per-check, review-flag and per-category dimensions in that cursor so a
 * resumed run's report describes the run rather than the slice this invocation
 * walked. Those two properties are what the cases below assert, against
 * PostgreSQL, because a rollback is the mechanism and nothing else can stand in
 * for it.
 *
 * WHY IT NEEDS A DATABASE (Rule backend-architecture §11). Atomicity is not
 * observable in a fake: `$transaction` in an in-memory double either applies
 * the writes or does not run them, and in both cases the assertion would be
 * about the double. Here the graph and the ledger are one real client, the
 * harness rolls a food's transaction back the way a crash does, and the three
 * records are read back from their tables. The pure halves — the count delta,
 * the dimension delta, the lenient cursor reader and the pending-count holder —
 * are asserted with no database at all, as that rule also requires.
 *
 * HOW IT DRIVES THE STAGE. Through `runValidation(deps)` only, with the clock,
 * the logger, the report writer, the advisory-review vendor seam and the budget
 * ledger injected (dependency injection over mocking). Nothing here mocks a
 * script or service internal, no vendor is reached, and the budget seam
 * delegates to the real `scripts/lib/budget.ts` against the real tables.
 *
 * WHAT IT DELIBERATELY DOES NOT COVER. The check verdicts, the tiers and the
 * tag vocabulary belong to `src/services/__tests__/catalog.logic.test.ts`; the
 * completed-run no-op, the version predicate and the duplicate-identity skip to
 * `catalog-import.test.ts`'s `runValidation` section, which drives the same
 * function with an in-memory graph; release loading to `catalog-load.test.ts`.
 * This file is about the unit of work, the resume accounting and the log
 * volume, and it fixes the fixtures' dispositions only so far as those need.
 *
 * Jest's `roots` is `<rootDir>/src` (jest.config.ts), so a test file under
 * `scripts/` would never be collected; the relative imports into `scripts/` are
 * the consequence of that, not a choice. `scripts/lib/bootstrap.ts` is
 * deliberately NOT imported: Jest is not a script process, and its
 * `dotenv.config()` would overwrite the environment `jestSetup.ts` controls.
 */
import { prisma } from '../../prisma/client';
import { CATALOG_CHECK_NAMES } from '../../services/catalog.logic';
import {
    applyDimensionDelta,
    createPendingCountHolder,
    dimensionsFromJudgedRecords,
    emptyAdvisoryReviewSpend,
    emptyValidationDimensions,
    readValidationCursor,
    runValidation,
    validationCountDelta,
    validationPlanFingerprint,
    validationRunScope,
} from '../../../scripts/catalog-validate';
import type {
    JudgedValidationRecord,
    RunValidationDeps,
    ValidateDb,
    ValidateOptions,
    ValidationBudget,
    ValidationCursor,
    ValidationReviewClient,
    ValidationWriteOutcome,
} from '../../../scripts/catalog-validate';
import { NO_CATALOG_INPUT } from '../../../scripts/lib/checkpoint';
import type { CatalogRunDb } from '../../../scripts/lib/checkpoint';
import { recordModelCallUsage, reserveModelCall } from '../../../scripts/lib/budget';
import { createLogger } from '../../../scripts/lib/logger';
import type { LogLevel } from '../../../scripts/lib/logger';
import { loadCoveragePlan } from '../../../scripts/lib/manifest';
import type { CoveragePlan } from '../../../scripts/lib/manifest';
import { truncateFeatureTables } from '../setup/testDb';

/* -------------------------------------------------------------------------- *
 * Fixtures
 * -------------------------------------------------------------------------- */

/** The shipped coverage plan, loaded once. Nothing here varies it on disk. */
const coveragePlan: CoveragePlan = loadCoveragePlan();

/**
 * `protein_poultry`'s reviewed band is 80–350 kcal/100 g with a 15 % energy
 * tolerance, which is what lets one fixture publish cleanly and another publish
 * carrying a review-tier flag — the two dispositions every case below is built
 * from.
 */
const CATEGORY = 'protein_poultry';

const categoryPlan = coveragePlan.categories.find((entry) => entry.category === CATEGORY);

if (categoryPlan === undefined) {
    throw new Error(`the coverage plan no longer declares ${CATEGORY}, which every fixture here is built on`);
}

/** The plan's own total, summed the way the report sums it (per category, never the aggregate). */
const PUBLISHED_TARGET_SUM = coveragePlan.categories.reduce((total, entry) => total + entry.publishedTarget, 0);

/** Every clock the stage can read is this one. No assertion reads the wall clock. */
const FIXED_NOW = new Date('2026-09-14T12:00:00.000Z');

/**
 * Injected, never resolved from the environment: `getReviewModel()` reads
 * `CATALOG_REVIEW_MODEL` and falls back through the OpenRouter boundary, which
 * `jestSetup.ts` deliberately leaves unconfigured. A model name passed in as
 * data is what keeps this suite offline by construction.
 */
const REVIEW_MODEL = 'harness/review-model';

/** Wide enough that no case here is about the cap; exhaustion is generation's suite. */
const MODEL_CALL_BUDGET = 100;

const optionsOf = (overrides: Partial<ValidateOptions> = {}): ValidateOptions => ({
    help: false,
    categories: [],
    revalidateQuarantined: false,
    review: false,
    dryRun: false,
    ...overrides,
});

/**
 * The run key a set of options claims against an empty ledger.
 *
 * The suite seeds no ingest run, so the catalog input every case resolves is
 * `NO_CATALOG_INPUT`; `truncateFeatureTables` in each `beforeEach` keeps that
 * true whatever ran before it.
 */
const runScopeOf = (options: ValidateOptions): string =>
    validationRunScope(coveragePlan.coveragePlanVersion, options, NO_CATALOG_INPUT);

interface SeedFoodInput {
    /** Orders the considered list: it is `source_key` ascending. */
    readonly ordinal: number;
    readonly identitySource?: 'usda' | 'ai_generated';
    /** 600 kcal is outside the category's reviewed band; 165 is inside it. */
    readonly calories?: number;
    readonly proteinG?: number;
    readonly fatG?: number;
    /**
     * `per_100ml` with no density fails `missing_density`, which is a
     * QUARANTINE-tier check — the one disposition the fixtures otherwise lack,
     * and the one a resume case needs: a quarantined row leaves the considered
     * set on the next attempt (it needs `--revalidate-quarantined` to come
     * back) while its failed check still belongs to the run's figures.
     */
    readonly nutritionBasis?: 'per_100g' | 'per_100ml';
}

/**
 * One candidate row, written through Prisma so the stage reads what a real
 * import would have left.
 *
 * The passing values are the category's own: 165 kcal against 31 g protein and
 * 3.6 g fat is inside both the reviewed band and the 15 % energy tolerance, and
 * the single sourced default portion satisfies the nutrition-basis rule — so a
 * fixture's disposition is decided by the one field a case varies and never by
 * arithmetic nobody intended.
 */
const seedFood = async (input: SeedFoodInput): Promise<{ id: string; sourceKey: string }> => {
    const generated = input.identitySource === 'ai_generated';
    const name = `harness poultry cut ${input.ordinal}`;
    const sourceKey = generated
        ? `ai:${CATEGORY}:${name}:raw`
        : `usda:90000${input.ordinal}`;

    const row = await prisma.catalog_foods.create({
        data: {
            source_key: sourceKey,
            canonical_name: name,
            display_name: `Harness poultry cut ${input.ordinal}`,
            category: CATEGORY,
            food_state: 'raw',
            identity_source: generated ? 'ai_generated' : 'usda',
            identity_status: 'verified',
            nutrition_provenance: generated ? 'ai_estimated' : 'source_backed',
            nutrition_version: 1,
            metadata_version: 1,
            nutrition_basis: input.nutritionBasis ?? 'per_100g',
            basis_amount: 100,
            calories: input.calories ?? 165,
            protein_g: input.proteinG ?? 31,
            carbs_g: 0,
            fat_g: input.fatG ?? 3.6,
            fiber_g: null,
            density_g_per_ml: null,
            usda_fdc_id: generated ? null : 90000 + input.ordinal,
            usda_data_type: generated ? null : 'sr_legacy_food',
            publication_status: 'candidate',
            allergen_tags: [],
            allergen_status: 'known',
            diet_tags: [],
            food_group: 'poultry',
            is_common_dislike: false,
            cost_class: 2,
            search_text: name,
            imported_at: FIXED_NOW,
            catalog_food_portions: {
                create: {
                    description: '1 cut',
                    amount: 1,
                    unit: 'each',
                    gram_weight: 174,
                    source: 'usda_food_portion',
                    is_default: true,
                },
            },
        },
        select: { id: true, source_key: true },
    });

    return { id: row.id, sourceKey: row.source_key };
};

/** A row every check passes: `published`, with no failed check to report. */
const seedPassingFood = (ordinal: number): Promise<{ id: string; sourceKey: string }> => seedFood({ ordinal });

/**
 * A USDA row whose energy is outside the category's reviewed band: it PUBLISHES
 * with `out_of_category_range` recorded (the vendor asserted the value), so it
 * contributes one failed check, one review flag and one published row — the
 * three dimensions the resume cases are about — without changing the considered
 * set on the next attempt.
 */
const seedFlaggedFood = (ordinal: number): Promise<{ id: string; sourceKey: string }> =>
    seedFood({ ordinal, calories: 600, proteinG: 20, fatG: 58 });

/**
 * A GENERATED row with the same out-of-band energy: quarantined, held by that
 * review-tier flag alone, with a verified identity and no pending
 * classification — which is exactly `advisoryReviewApplies`, so `--review`
 * spends a call on it.
 */
const seedReviewableFood = (ordinal: number): Promise<{ id: string; sourceKey: string }> =>
    seedFood({ ordinal, identitySource: 'ai_generated', calories: 600, proteinG: 20, fatG: 58 });

/**
 * A row two REJECT-tier checks fail — 500 g of protein per 100 g is both above
 * the macro-mass ceiling and irreconcilable with 165 kcal.
 *
 * Its disposition is what a resume case needs: `rejected` takes the row out of
 * `allRows` altogether (the stage reads candidate, published and quarantined),
 * so after this pass judges it, nothing a later attempt reads can see it — and
 * only its validation record can still account for the two checks it failed.
 */
const seedRejectedFood = (ordinal: number): Promise<{ id: string; sourceKey: string }> =>
    seedFood({ ordinal, proteinG: 500 });

/** A row `missing_density` quarantines: per 100 ml with no density to convert it. */
const seedQuarantinedFood = (ordinal: number): Promise<{ id: string; sourceKey: string }> =>
    seedFood({ ordinal, nutritionBasis: 'per_100ml' });

/* -------------------------------------------------------------------------- *
 * Reading what a pass left
 * -------------------------------------------------------------------------- */

interface RunRow {
    readonly id: string;
    readonly status: string;
    readonly cursor: unknown;
    readonly counts: Record<string, number>;
    readonly log: Record<string, unknown>[];
}

const runRow = async (options: ValidateOptions): Promise<RunRow | null> => {
    const row = await prisma.catalog_import_runs.findFirst({
        where: { kind: 'validation', manifest_version: runScopeOf(options) },
        select: { id: true, status: true, cursor: true, counts: true, log: true },
    });

    if (row === null) {
        return null;
    }

    return {
        id: row.id,
        status: row.status,
        cursor: row.cursor,
        counts: (row.counts ?? {}) as Record<string, number>,
        log: ((row.log ?? []) as Record<string, unknown>[]) ?? [],
    };
};

const requireRunRow = async (options: ValidateOptions): Promise<RunRow> => {
    const row = await runRow(options);
    expect(row).not.toBeNull();
    return row as RunRow;
};

const storedCursor = (row: RunRow): Partial<ValidationCursor> => (row.cursor ?? {}) as Partial<ValidationCursor>;

const publicationStatusOf = async (id: string): Promise<string | null> => {
    const row = await prisma.catalog_foods.findUnique({ where: { id }, select: { publication_status: true } });
    return row?.publication_status ?? null;
};

/** Every history entry a food's validation record carries, or `null` when it has no record. */
const historyOf = async (id: string): Promise<unknown[] | null> => {
    const record = await prisma.catalog_validation_records.findUnique({
        where: { catalog_food_id: id },
        select: { history: true },
    });

    if (record === null) {
        return null;
    }

    return Array.isArray(record.history) ? (record.history as unknown[]) : [];
};

/* -------------------------------------------------------------------------- *
 * The harness: one real client, traced, with the interruptions a crash makes
 * -------------------------------------------------------------------------- */

/** A mutating statement, and the transaction it ran in. `0` means none. */
interface TracedWrite {
    readonly transaction: number;
    readonly table: string;
    readonly operation: string;
    readonly dataKeys: readonly string[];
    readonly id: string | null;
}

/** Raised by the harness where a crash would happen, so a case can assert on it. */
class HarnessInterruption extends Error {
    public constructor(ordinal: number) {
        super(`the harness interrupted the pass before food transaction ${ordinal}`);
        this.name = 'HarnessInterruption';
    }
}

/** Raised INSIDE a food's transaction, so PostgreSQL rolls the whole unit back. */
class HarnessRollback extends Error {
    public constructor(ordinal: number) {
        super(`the harness rolled food transaction ${ordinal} back after its work ran`);
        this.name = 'HarnessRollback';
    }
}

/** Raised where the run row's own write fails, which is the other half of the window F08 closes. */
class HarnessLedgerFailure extends Error {
    public constructor(field: string) {
        super(`the harness refused the run row's ${field} write`);
        this.name = 'HarnessLedgerFailure';
    }
}

interface HarnessHooks {
    /**
     * Runs before the nth (1-based) food transaction OPENS, which is the one
     * window in which a concurrent writer can touch the row without queueing
     * behind its `FOR UPDATE` lock. Used to delete a row under the pass.
     */
    readonly beforeFoodTransaction?: (ordinal: number) => Promise<void>;
    /** Throws instead of opening the nth food transaction: an interrupted pass. */
    readonly interruptBeforeFoodTransaction?: number;
    /** Runs the nth food transaction's work and then throws: a crash mid-commit. */
    readonly rollbackFoodTransaction?: number;
    /**
     * Food ids whose guarded status write is made to miss.
     *
     * The stage's compare-and-set carries the versions and status its locked
     * re-read returned; a racing writer's version bump is what makes that
     * predicate match nothing. The harness produces the same condition the only
     * way an in-process test can — the row lock is held, so a second writer
     * would queue behind it until the transaction timeout — by adding to the
     * version in the predicate. The real statement runs and the zero count is a
     * real zero.
     */
    readonly missCompareAndSet?: ReadonlySet<string>;
    /**
     * Refuses the run row's `cursor`, `counts` or `log` write made from INSIDE a
     * food's transaction — the one failure that tells the two designs apart.
     *
     * With the ledger writes in the food's transaction, refusing one has to undo
     * the judgement as well: that is what "one unit of work" means. A stage that
     * wrote the cursor in a transaction of its own would leave the judgement
     * committed and the cursor missing, which is the state a resumed pass has to
     * detect from the row's own history instead of from its pointer.
     */
    readonly failLedgerWrite?: 'cursor' | 'counts' | 'log';
}

const TRACED_MODELS: ReadonlySet<string> = new Set([
    'catalog_foods',
    'catalog_food_aliases',
    'catalog_validation_records',
    'catalog_import_runs',
    'catalog_generation_batches',
]);

const MUTATIONS: ReadonlySet<string> = new Set([
    'create',
    'createMany',
    'update',
    'updateMany',
    'upsert',
    'delete',
    'deleteMany',
]);

interface TracedClient {
    /** Passed as BOTH `db` and `runDb`, so the stage resolves the run row through the transaction client. */
    readonly client: ValidateDb & CatalogRunDb;
    readonly writes: readonly TracedWrite[];
    /** How many food transactions were opened. */
    foodTransactions(): number;
}

/**
 * Wraps the real Prisma client so every mutating statement is recorded with the
 * transaction it ran in, and so a case can interrupt the pass exactly where a
 * crash would.
 *
 * WHY ONE OBJECT IS PASSED AS BOTH SEAMS: `runValidation` writes the run row
 * from inside a food's transaction only when its graph client and its ledger
 * client are the same client — that is the condition `RunValidationDeps.runDbIn`
 * documents, and it is what `main()` satisfies by passing one singleton to
 * both. A harness that passed two objects would be testing the fallback.
 *
 * HOW A FOOD'S TRANSACTION IS RECOGNISED: it is the only one the stage opens
 * with options (`{ timeout: TRANSACTION_TIMEOUT_MS }`); `lib/checkpoint.ts`
 * opens its own with none. So `options !== undefined` identifies it without the
 * harness having to guess from the statements inside.
 */
const createTracedClient = (hooks: HarnessHooks = {}): TracedClient => {
    const writes: TracedWrite[] = [];
    const foodTransactionIds = new Set<number>();
    let transactions = 0;
    let foodTransactions = 0;

    const tracedModel = (model: object, table: string, transaction: number): object =>
        new Proxy(model, {
            get: (target, property) => {
                const value = Reflect.get(target, property);
                const operation = String(property);

                if (typeof value !== 'function') {
                    return value;
                }

                const call = value as (args: unknown) => Promise<unknown>;

                return async (args: unknown): Promise<unknown> => {
                    let effective = args;

                    if (
                        table === 'catalog_import_runs' &&
                        hooks.failLedgerWrite !== undefined &&
                        foodTransactionIds.has(transaction)
                    ) {
                        const data = (args as { data?: Record<string, unknown> }).data ?? {};
                        if (Object.keys(data).includes(hooks.failLedgerWrite)) {
                            throw new HarnessLedgerFailure(hooks.failLedgerWrite);
                        }
                    }

                    if (table === 'catalog_foods' && operation === 'updateMany' && hooks.missCompareAndSet) {
                        const where = (args as { where?: Record<string, unknown> }).where ?? {};
                        const id = typeof where.id === 'string' ? where.id : null;
                        if (id !== null && hooks.missCompareAndSet.has(id)) {
                            effective = {
                                ...(args as Record<string, unknown>),
                                where: {
                                    ...where,
                                    nutrition_version: Number(where.nutrition_version ?? 0) + 1000,
                                },
                            };
                        }
                    }

                    const result = await call.call(target, effective);

                    if (MUTATIONS.has(operation)) {
                        const data = (effective as { data?: Record<string, unknown> }).data;
                        const where = (effective as { where?: Record<string, unknown> }).where;
                        writes.push({
                            transaction,
                            table,
                            operation,
                            dataKeys: data === undefined || data === null ? [] : Object.keys(data),
                            id: typeof where?.id === 'string' ? where.id : null,
                        });
                    }

                    return result;
                };
            },
        });

    const traced = (target: object, transaction: number): object =>
        new Proxy(target, {
            get: (client, property) => {
                const value = Reflect.get(client, property);

                if (property === '$transaction' && typeof value === 'function') {
                    const runner = value as (
                        work: (tx: unknown) => Promise<unknown>,
                        options?: unknown,
                    ) => Promise<unknown>;

                    return async (work: (tx: unknown) => Promise<unknown>, options?: unknown): Promise<unknown> => {
                        const isFoodTransaction = options !== undefined;
                        let ordinal = 0;

                        if (isFoodTransaction) {
                            foodTransactions += 1;
                            ordinal = foodTransactions;

                            if (hooks.beforeFoodTransaction) {
                                await hooks.beforeFoodTransaction(ordinal);
                            }
                            if (ordinal === hooks.interruptBeforeFoodTransaction) {
                                throw new HarnessInterruption(ordinal);
                            }
                        }

                        transactions += 1;
                        const id = transactions;
                        if (isFoodTransaction) {
                            foodTransactionIds.add(id);
                        }

                        return runner.call(
                            client,
                            async (tx: unknown) => {
                                const result = await work(traced(tx as object, id));
                                if (isFoodTransaction && ordinal === hooks.rollbackFoodTransaction) {
                                    throw new HarnessRollback(ordinal);
                                }
                                return result;
                            },
                            options,
                        );
                    };
                }

                if (TRACED_MODELS.has(String(property)) && typeof value === 'object' && value !== null) {
                    return tracedModel(value as object, String(property), transaction);
                }

                return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(client) : value;
            },
        });

    return {
        client: traced(prisma as unknown as object, 0) as unknown as ValidateDb & CatalogRunDb,
        writes,
        foodTransactions: () => foodTransactions,
    };
};

interface LoggedLine {
    readonly level: LogLevel;
    readonly line: string;
}

interface Harness {
    readonly deps: RunValidationDeps;
    readonly traced: TracedClient;
    readonly reports: readonly unknown[];
    readonly lines: readonly LoggedLine[];
    entries(): Record<string, unknown>[];
    entriesFor(event: string): { level: LogLevel; fields: Record<string, unknown> }[];
    readonly modelCalls: readonly string[];
}

interface HarnessOptions {
    readonly options?: ValidateOptions;
    readonly hooks?: HarnessHooks;
    /** The model's answer per call ordinal. Throwing is a vendor failure. */
    readonly respond?: (ordinal: number) => unknown;
    readonly logLevel?: LogLevel;
}

/**
 * One invocation's dependencies: the traced client for both seams, an injected
 * clock, a capturing logger, a report sink, and — only when the case passes
 * `--review` — the vendor seam and the real budget ledger.
 */
const createHarness = (harnessOptions: HarnessOptions = {}): Harness => {
    const options = harnessOptions.options ?? optionsOf();
    const traced = createTracedClient(harnessOptions.hooks);
    const reports: unknown[] = [];
    const lines: LoggedLine[] = [];
    const modelCalls: string[] = [];

    const review: ValidationReviewClient = {
        call: async (_systemPrompt, userContent, _schema, model) => {
            modelCalls.push(model);
            const respond = harnessOptions.respond;
            return respond === undefined ? { assessments: [] } : respond(modelCalls.length);
        },
    };

    // Delegating to the real ledger rather than standing in for it: a
    // reservation is a row, and the aggregates the summary reports are read back
    // through the same functions production uses.
    const budget: ValidationBudget = {
        reserve: (input) => reserveModelCall(prisma as unknown as CatalogRunDb, input),
        record: (input) => recordModelCallUsage(prisma as unknown as CatalogRunDb, input),
    };

    const reviewEnabled = options.review && !options.dryRun;

    const deps: RunValidationDeps = {
        db: traced.client,
        runDb: traced.client,
        coveragePlan,
        options,
        logger: createLogger('catalog-validate', {
            level: harnessOptions.logLevel ?? 'debug',
            write: (line, level) => {
                lines.push({ line, level });
            },
            now: () => FIXED_NOW,
        }),
        now: () => FIXED_NOW,
        writeReport: (report) => {
            reports.push(report);
        },
        review: reviewEnabled ? review : undefined,
        budget: reviewEnabled ? budget : undefined,
        reviewModel: reviewEnabled ? REVIEW_MODEL : undefined,
        modelCallBudget: reviewEnabled ? MODEL_CALL_BUDGET : undefined,
    };

    const entries = (): Record<string, unknown>[] =>
        lines.map((entry) => JSON.parse(entry.line) as Record<string, unknown>);

    return {
        deps,
        traced,
        reports,
        lines,
        modelCalls,
        entries,
        entriesFor: (event) =>
            lines
                .map((entry) => ({ level: entry.level, fields: JSON.parse(entry.line) as Record<string, unknown> }))
                .filter((entry) => entry.fields.event === event),
    };
};

/** A report as the cases read it. Only the fields they assert on are named. */
interface ValidationReport {
    readonly counts: Record<string, number>;
    readonly failedChecks: Record<string, number>;
    readonly reviewFlags: Record<string, number>;
    readonly invocation: {
        readonly resumed: boolean;
        readonly restartedBecausePlanChanged: boolean;
        readonly startIndex: number;
        readonly judged: number;
        readonly talliesRestoredFromCursor: boolean;
        readonly talliesRebuiltFromRecords: boolean;
        readonly figureScope: Record<string, string>;
    };
    readonly coverage: {
        readonly publishedActualTotal: number;
        readonly shortfallTotal: number;
        readonly byCategory: Record<string, { published: number; target: number; shortfall: number }>;
    };
    readonly skipped: { readonly vanished: string[]; readonly raced: string[]; readonly identityGroupMoved: string[] };
    readonly modelCalls: Record<string, unknown>;
}

const onlyReport = (harness: Harness): ValidationReport => {
    expect(harness.reports).toHaveLength(1);
    return harness.reports[0] as ValidationReport;
};

const rejectionOf = async (work: Promise<unknown>): Promise<unknown> =>
    work.then(
        () => null,
        (error: unknown) => error,
    );

/* -------------------------------------------------------------------------- *
 * The pure halves — no database, no process environment.
 * -------------------------------------------------------------------------- */

describe('validationCountDelta', () => {
    const judged = (overrides: Partial<Extract<ValidationWriteOutcome, { outcome: 'judged' }>> = {}) =>
        ({
            outcome: 'judged',
            publicationStatus: 'published',
            previousStatus: 'candidate',
            verdict: {
                publicationStatus: 'published',
                outcome: 'accepted',
                reviewFlags: [],
                decidingCheckNames: [],
                countsTowardPublishedTarget: true,
                checks: [],
                normalizedNutrition: null,
            },
            identityHeld: false,
            awaitingClassification: false,
            category: CATEGORY,
            ...overrides,
        }) as ValidationWriteOutcome;

    it('counts one judgement and the status it left', () => {
        expect(validationCountDelta(judged())).toEqual({ judged: 1, published: 1 });
    });

    it('counts an unchanged status as well as the status itself', () => {
        expect(validationCountDelta(judged({ publicationStatus: 'quarantined', previousStatus: 'quarantined' }))).toEqual(
            { judged: 1, quarantined: 1, unchanged: 1 },
        );
    });

    it('counts the two floors the stage applies after the checks', () => {
        expect(
            validationCountDelta(judged({ publicationStatus: 'quarantined', identityHeld: true })),
        ).toMatchObject({ identityNotVerified: 1 });
        expect(
            validationCountDelta(judged({ publicationStatus: 'candidate', awaitingClassification: true })),
        ).toMatchObject({ candidatesHeld: 1, awaitingClassification: 1 });
    });

    it.each([
        ['vanished', 'vanished'],
        ['raced', 'raced'],
        ['identity_moved', 'identityGroupMoved'],
    ])('counts a %s row exactly once, as %s', (outcome, key) => {
        expect(validationCountDelta({ outcome } as ValidationWriteOutcome)).toEqual({ [key]: 1 });
    });

    it('never counts a judgement for a row it did not judge', () => {
        for (const outcome of ['vanished', 'raced', 'identity_moved'] as const) {
            expect(validationCountDelta({ outcome } as ValidationWriteOutcome).judged).toBeUndefined();
        }
    });
});

describe('applyDimensionDelta', () => {
    const outcome = (
        publicationStatus: string,
        failed: readonly string[],
        reviewFlags: readonly string[],
    ): ValidationWriteOutcome =>
        ({
            outcome: 'judged',
            publicationStatus,
            previousStatus: 'candidate',
            verdict: {
                publicationStatus,
                outcome: publicationStatus === 'published' ? 'accepted' : 'quarantined',
                reviewFlags: [...reviewFlags],
                decidingCheckNames: [],
                countsTowardPublishedTarget: publicationStatus === 'published',
                checks: [
                    { name: 'kcal_ceiling', pass: true, observed: null, bound: null, tier: 'reject' },
                    ...failed.map((name) => ({ name, pass: false, observed: null, bound: null, tier: 'review' })),
                ],
                normalizedNutrition: null,
            },
            identityHeld: false,
            awaitingClassification: false,
            category: CATEGORY,
        }) as unknown as ValidationWriteOutcome;

    it('accumulates failed checks, review flags and published categories', () => {
        const first = applyDimensionDelta(
            emptyValidationDimensions(),
            outcome('published', [CATALOG_CHECK_NAMES.OUT_OF_CATEGORY_RANGE], [CATALOG_CHECK_NAMES.OUT_OF_CATEGORY_RANGE]),
        );
        const second = applyDimensionDelta(
            first,
            outcome('published', [CATALOG_CHECK_NAMES.OUT_OF_CATEGORY_RANGE], [CATALOG_CHECK_NAMES.OUT_OF_CATEGORY_RANGE]),
        );

        expect(second.byCheck).toEqual({ [CATALOG_CHECK_NAMES.OUT_OF_CATEGORY_RANGE]: 2 });
        expect(second.reviewFlags).toEqual({ [CATALOG_CHECK_NAMES.OUT_OF_CATEGORY_RANGE]: 2 });
        expect(second.publishedByCategory).toEqual({ [CATEGORY]: 2 });
    });

    it('does not mutate the dimensions it is given', () => {
        const base = emptyValidationDimensions();
        applyDimensionDelta(base, outcome('published', ['kcal_ceiling'], []));
        expect(base.byCheck).toEqual({});
        expect(base.publishedByCategory).toEqual({});
    });

    it('counts a quarantined row in no category', () => {
        const next = applyDimensionDelta(emptyValidationDimensions(), outcome('quarantined', [], []));
        expect(next.publishedByCategory).toEqual({});
    });

    it('adds nothing for a row that was not judged', () => {
        const base = applyDimensionDelta(emptyValidationDimensions(), outcome('published', ['kcal_ceiling'], []));
        expect(applyDimensionDelta(base, { outcome: 'raced' } as ValidationWriteOutcome)).toBe(base);
    });
});

/**
 * The other derivation of the same three figures: from the records a run
 * committed rather than from the outcome of one food.
 *
 * It is what makes a resumed report complete when the cursor's cached tallies
 * were discarded with the positions they sat beside — which ORDINARY
 * judgement causes, since a rejected row leaves the considered set and the plan
 * fingerprint stops matching. Asserted on rows, with no database, because the
 * derivation is pure (Rule backend-architecture §7).
 */
describe('dimensionsFromJudgedRecords (SCRBLD-F43)', () => {
    const RUN = 'run-under-test';

    const entry = (runId: string | undefined, to: string | null = 'published'): Record<string, unknown> => ({
        at: FIXED_NOW.toISOString(),
        ...(runId === undefined ? {} : { run: runId }),
        from: 'candidate',
        // `null` omits the member, which is what an entry written before the
        // field existed looks like to the derivation.
        ...(to === null ? {} : { to }),
    });

    const check = (name: string, pass: boolean): Record<string, unknown> => ({
        name,
        pass,
        observed: null,
        bound: null,
        // Stored by the judgement and deliberately IGNORED by the derivation,
        // which reads the tier from catalog.logic.ts's current map. A record
        // whose stored tier disagrees must not be able to invent a review flag.
        tier: 'reject',
    });

    const record = (overrides: Partial<JudgedValidationRecord> = {}): JudgedValidationRecord => {
        const publicationStatus = overrides.publication_status ?? 'published';

        return {
            checks: [check(CATALOG_CHECK_NAMES.KCAL_CEILING, true)],
            publication_status: publicationStatus,
            // A real judgement writes an entry stating the status it wrote, so
            // the default fixture keeps the two coherent rather than pitting an
            // entry that says `published` against a rejected record. The cases
            // that WANT them to diverge pass their own history.
            history: [entry(RUN, publicationStatus)],
            catalog_foods: { category: CATEGORY },
            ...overrides,
        };
    };

    it('counts the failed checks, the review flags and the published categories of the records this run judged', () => {
        const rebuilt = dimensionsFromJudgedRecords(
            [
                record({
                    checks: [
                        check(CATALOG_CHECK_NAMES.KCAL_CEILING, true),
                        check(CATALOG_CHECK_NAMES.OUT_OF_CATEGORY_RANGE, false),
                    ],
                }),
                record(),
            ],
            RUN,
        );

        expect(rebuilt.judgedFoods).toBe(2);
        expect(rebuilt.recordsRead).toBe(2);
        expect(rebuilt.dimensions.byCheck).toEqual({ [CATALOG_CHECK_NAMES.OUT_OF_CATEGORY_RANGE]: 1 });
        // A review flag is a FAILED check whose current tier is `review`, which
        // is how resolveCatalogDisposition derives verdict.reviewFlags — and the
        // stored `tier: 'reject'` above is not what decided it.
        expect(rebuilt.dimensions.reviewFlags).toEqual({ [CATALOG_CHECK_NAMES.OUT_OF_CATEGORY_RANGE]: 1 });
        expect(rebuilt.dimensions.publishedByCategory).toEqual({ [CATEGORY]: 2 });
    });

    it('counts a rejected record in the checks and in no category', () => {
        const rebuilt = dimensionsFromJudgedRecords(
            [
                record({
                    publication_status: 'rejected',
                    checks: [
                        check(CATALOG_CHECK_NAMES.MACRO_MASS_CEILING, false),
                        check(CATALOG_CHECK_NAMES.ENERGY_MACRO_MISMATCH, false),
                    ],
                }),
            ],
            RUN,
        );

        expect(rebuilt.judgedFoods).toBe(1);
        expect(rebuilt.dimensions.byCheck).toEqual({
            [CATALOG_CHECK_NAMES.MACRO_MASS_CEILING]: 1,
            [CATALOG_CHECK_NAMES.ENERGY_MACRO_MISMATCH]: 1,
        });
        expect(rebuilt.dimensions.reviewFlags).toEqual({});
        expect(rebuilt.dimensions.publishedByCategory).toEqual({});
    });

    it.each([
        ['a record another run judged', [entry('some-other-run')]],
        ['a record no run stamped', [entry(undefined)]],
        ['a history that is not an array', { at: FIXED_NOW.toISOString(), run: RUN }],
        ['a record with no history at all', null],
    ])('counts nothing for %s', (_description, history) => {
        const rebuilt = dimensionsFromJudgedRecords([record({ history })], RUN);

        expect(rebuilt.judgedFoods).toBe(0);
        expect(rebuilt.recordsRead).toBe(1);
        expect(rebuilt.dimensions).toEqual(emptyValidationDimensions());
    });

    it('counts the run entry among several, so an older release\'s history is no obstacle', () => {
        const rebuilt = dimensionsFromJudgedRecords(
            [record({ history: [entry(undefined), entry('an-earlier-run'), entry(RUN)] })],
            RUN,
        );

        expect(rebuilt.judgedFoods).toBe(1);
        expect(rebuilt.dimensions.publishedByCategory).toEqual({ [CATEGORY]: 1 });
    });

    it.each([
        ['checks that are not an array', 'nothing the column can hold as a list'],
        ['a null checks column', null],
    ])('still counts the record when its %s', (_description, checks) => {
        const rebuilt = dimensionsFromJudgedRecords([record({ checks })], RUN);

        // The status and the category are columns of their own, so a record
        // whose checks cannot be read still belongs to the category it
        // published in. Losing the whole record would understate the coverage
        // this derivation exists to state exactly.
        expect(rebuilt.judgedFoods).toBe(1);
        expect(rebuilt.dimensions.byCheck).toEqual({});
        expect(rebuilt.dimensions.publishedByCategory).toEqual({ [CATEGORY]: 1 });
    });

    it('reads the entries of a checks array that are readable and skips the rest', () => {
        const rebuilt = dimensionsFromJudgedRecords(
            [
                record({
                    checks: [
                        null,
                        'missing_density',
                        { name: 42, pass: false },
                        { name: CATALOG_CHECK_NAMES.MISSING_DENSITY, pass: 'no' },
                        check(CATALOG_CHECK_NAMES.MISSING_DENSITY, false),
                    ],
                    publication_status: 'quarantined',
                }),
            ],
            RUN,
        );

        expect(rebuilt.dimensions.byCheck).toEqual({ [CATALOG_CHECK_NAMES.MISSING_DENSITY]: 1 });
        expect(rebuilt.dimensions.publishedByCategory).toEqual({});
    });

    it('returns empty dimensions for no records at all', () => {
        expect(dimensionsFromJudgedRecords([], RUN)).toEqual({
            dimensions: emptyValidationDimensions(),
            judgedFoods: 0,
            recordsRead: 0,
        });
    });

    // THE FIGURE MEANS "WHAT THIS RUN DECIDED", because that is what the
    // in-memory path counts (applyDimensionDelta reads `written`), and one
    // report field must not change meaning according to whether the pass
    // resumed from a cursor or rebuilt from records. The two sources diverge
    // only after a differently-keyed pass (`--category`, `--review`) judges a
    // row between this run's interruption and its resume — and then the entry
    // is still right about this run while the record is not.
    it('counts the status this run wrote, not a later pass\'s', () => {
        const rebuilt = dimensionsFromJudgedRecords(
            [record({ publication_status: 'rejected', history: [entry(RUN, 'published')] })],
            RUN,
        );

        expect(rebuilt.judgedFoods).toBe(1);
        expect(rebuilt.dimensions.publishedByCategory).toEqual({ [CATEGORY]: 1 });
    });

    it('falls back to the record\'s status for an entry written before the field existed', () => {
        const published = dimensionsFromJudgedRecords(
            [record({ publication_status: 'published', history: [entry(RUN, null)] })],
            RUN,
        );
        const rejected = dimensionsFromJudgedRecords(
            [record({ publication_status: 'rejected', history: [entry(RUN, null)] })],
            RUN,
        );

        expect(published.dimensions.publishedByCategory).toEqual({ [CATEGORY]: 1 });
        expect(rejected.dimensions.publishedByCategory).toEqual({});
    });

    it('counts the review flags this run\'s verdict raised', () => {
        const rebuilt = dimensionsFromJudgedRecords(
            [
                record({
                    // The record's checks would derive `out_of_category_range`;
                    // the entry states what the verdict actually raised.
                    checks: [check(CATALOG_CHECK_NAMES.OUT_OF_CATEGORY_RANGE, false)],
                    history: [
                        {
                            ...entry(RUN),
                            review_flags: [CATALOG_CHECK_NAMES.ALLERGENS_UNKNOWN],
                        },
                    ],
                }),
            ],
            RUN,
        );

        expect(rebuilt.dimensions.reviewFlags).toEqual({ [CATALOG_CHECK_NAMES.ALLERGENS_UNKNOWN]: 1 });
        // The failed check is still counted: `byCheck` counts every failure and
        // the entry carries only the deciding subset, so that one figure comes
        // from the record.
        expect(rebuilt.dimensions.byCheck).toEqual({ [CATALOG_CHECK_NAMES.OUT_OF_CATEGORY_RANGE]: 1 });
    });

    it('reads an entry that states no review flags as none, rather than deriving them', () => {
        const rebuilt = dimensionsFromJudgedRecords(
            [
                record({
                    checks: [check(CATALOG_CHECK_NAMES.OUT_OF_CATEGORY_RANGE, false)],
                    history: [{ ...entry(RUN), review_flags: [] }],
                }),
            ],
            RUN,
        );

        // An empty array is an ANSWER — this run's verdict raised nothing —
        // while an absent member is an entry that cannot answer. Only the
        // latter falls back to deriving the flags from the failed checks.
        expect(rebuilt.dimensions.reviewFlags).toEqual({});
        expect(rebuilt.dimensions.byCheck).toEqual({ [CATALOG_CHECK_NAMES.OUT_OF_CATEGORY_RANGE]: 1 });
    });

    it('ignores review-flag entries that are not strings', () => {
        const rebuilt = dimensionsFromJudgedRecords(
            [
                record({
                    checks: [check(CATALOG_CHECK_NAMES.OUT_OF_CATEGORY_RANGE, false)],
                    history: [
                        {
                            ...entry(RUN),
                            review_flags: [CATALOG_CHECK_NAMES.ALLERGENS_UNKNOWN, 42, null],
                        },
                    ],
                }),
            ],
            RUN,
        );

        expect(rebuilt.dimensions.reviewFlags).toEqual({ [CATALOG_CHECK_NAMES.ALLERGENS_UNKNOWN]: 1 });
    });
});

describe('readValidationCursor', () => {
    const FINGERPRINT = 'a'.repeat(64);

    const cursor = (overrides: Record<string, unknown> = {}): unknown => ({
        fingerprint: FINGERPRINT,
        nextIndex: 4,
        unjudged: [1, 3],
        tallies: {
            byCheck: { out_of_category_range: 2 },
            reviewFlags: { out_of_category_range: 2 },
            publishedByCategory: { [CATEGORY]: 3 },
            advisoryReview: { reserved: 2, used: 2, reviewed: 1, confirmed: 1, failed: 1, skippedAfterStop: 0 },
        },
        ...overrides,
    });

    it('reports a fresh start for an absent cursor', () => {
        expect(readValidationCursor(null, FINGERPRINT, 10)).toEqual({ kind: 'fresh' });
        expect(readValidationCursor(undefined, FINGERPRINT, 10)).toEqual({ kind: 'fresh' });
    });

    it('restarts when the cursor was saved against different work', () => {
        expect(readValidationCursor(cursor({ fingerprint: 'b'.repeat(64) }), FINGERPRINT, 10)).toEqual({
            kind: 'restart',
            savedFingerprint: 'b'.repeat(64),
        });
    });

    it('restarts rather than throwing when the index is not a number', () => {
        expect(readValidationCursor(cursor({ nextIndex: 'four' }), FINGERPRINT, 10).kind).toBe('restart');
    });

    it('resumes with the tallies the cursor carries', () => {
        const read = readValidationCursor(cursor(), FINGERPRINT, 10);

        expect(read).toMatchObject({
            kind: 'resume',
            nextIndex: 4,
            unjudged: [1, 3],
            talliesRestored: true,
        });
        expect(read.kind === 'resume' ? read.tallies.publishedByCategory : null).toEqual({ [CATEGORY]: 3 });
        expect(read.kind === 'resume' ? read.tallies.advisoryReview : null).toEqual({
            reserved: 2,
            used: 2,
            reviewed: 1,
            confirmed: 1,
            failed: 1,
            skippedAfterStop: 0,
        });
    });

    it('resumes an older cursor that carries no tallies at all, and reports that it carried none', () => {
        const read = readValidationCursor(
            { fingerprint: FINGERPRINT, nextIndex: 2, unjudged: [] },
            FINGERPRINT,
            10,
        );

        // `talliesRestored: false` is where the figures come FROM, not what the
        // report is reduced to: the stage answers it by rebuilding the three
        // dimensions from the run's committed records (see
        // dimensionsFromJudgedRecords and the resume cases below), so a cursor
        // written before the tallies existed still yields a complete report.
        expect(read).toMatchObject({ kind: 'resume', nextIndex: 2, talliesRestored: false });
        expect(read.kind === 'resume' ? read.tallies : null).toEqual({
            byCheck: {},
            reviewFlags: {},
            publishedByCategory: {},
            advisoryReview: { reserved: 0, used: 0, reviewed: 0, confirmed: 0, failed: 0, skippedAfterStop: 0 },
        });
    });

    it.each([
        ['an array where a map belongs', { tallies: { byCheck: [1, 2], reviewFlags: null, publishedByCategory: 7 } }],
        ['counters that are not numbers', { tallies: { byCheck: { a: 'two' }, publishedByCategory: { b: NaN } } }],
        ['a negative counter', { tallies: { byCheck: { a: -3 } } }],
    ])('resumes a garbled cursor rather than throwing: %s', (_description, overrides) => {
        const read = readValidationCursor(cursor(overrides), FINGERPRINT, 10);

        expect(read.kind).toBe('resume');
        expect(read.kind === 'resume' ? read.tallies.byCheck : null).toEqual({});
        expect(read.kind === 'resume' ? read.tallies.publishedByCategory : null).toEqual({});
        // AND REPORTS THE TALLIES AS UNRESTORED, which is the difference between
        // dropping a corrupt counter and adopting the hole it left: the stage
        // rebuilds all three maps from the records instead of resuming from a
        // figure it cannot trust.
        expect(read.kind === 'resume' ? read.talliesRestored : null).toBe(false);
    });

    it('adopts tallies whose maps are readable and empty, which is what a run that judged nothing has', () => {
        const read = readValidationCursor(
            {
                fingerprint: FINGERPRINT,
                nextIndex: 1,
                unjudged: [0],
                tallies: { byCheck: {}, reviewFlags: {}, publishedByCategory: {} },
            },
            FINGERPRINT,
            10,
        );

        expect(read).toMatchObject({ kind: 'resume', talliesRestored: true });
        expect(read.kind === 'resume' ? read.tallies.advisoryReview : null).toEqual(emptyAdvisoryReviewSpend());
    });

    it('clamps the index into the considered set and drops positions it has already passed', () => {
        expect(readValidationCursor(cursor({ nextIndex: 99 }), FINGERPRINT, 6)).toMatchObject({
            nextIndex: 6,
            unjudged: [1, 3],
        });
        expect(
            readValidationCursor(cursor({ nextIndex: 2, unjudged: [-1, 0, 2, 5, 'x'] }), FINGERPRINT, 6),
        ).toMatchObject({ nextIndex: 2, unjudged: [0] });
    });
});

describe('createPendingCountHolder', () => {
    it('writes the delta once and then has nothing pending', async () => {
        const written: Record<string, number>[] = [];
        const holder = createPendingCountHolder(async (delta) => {
            written.push(delta);
        });

        holder.add('judged', 2);
        holder.add('published', 1);
        await holder.flush();

        expect(written).toEqual([{ judged: 2, published: 1 }]);
        expect(holder.pending()).toEqual({});

        await holder.flush();
        expect(written).toHaveLength(1);
    });

    it('keeps the delta when the write fails, and writes it once on the next flush', async () => {
        const written: Record<string, number>[] = [];
        let failNext = true;
        const holder = createPendingCountHolder(async (delta) => {
            if (failNext) {
                failNext = false;
                throw new Error('the run row would not take the counts');
            }
            written.push(delta);
        });

        holder.add('aliasesMerged', 3);

        await expect(holder.flush()).rejects.toThrow('the run row would not take the counts');
        expect(holder.pending()).toEqual({ aliasesMerged: 3 });
        expect(written).toEqual([]);

        await holder.flush();

        expect(written).toEqual([{ aliasesMerged: 3 }]);
        expect(holder.pending()).toEqual({});
    });

    it('preserves a tally raised while the write was in flight', async () => {
        const written: Record<string, number>[] = [];
        const holder = createPendingCountHolder(async (delta) => {
            // Raised by the stage while this write was awaited: it belongs to
            // the NEXT flush, and the settlement of this one must not take it.
            holder.add('aliasesMerged', 5);
            written.push(delta);
        });

        holder.add('aliasesMerged', 2);
        await holder.flush();

        expect(written).toEqual([{ aliasesMerged: 2 }]);
        expect(holder.pending()).toEqual({ aliasesMerged: 5 });

        await holder.flush();

        expect(written).toEqual([{ aliasesMerged: 2 }, { aliasesMerged: 5 }]);
    });

    it('does not write at all when nothing is pending', async () => {
        let calls = 0;
        const holder = createPendingCountHolder(async () => {
            calls += 1;
        });

        await holder.flush();

        expect(calls).toBe(0);
    });
});

/* -------------------------------------------------------------------------- *
 * Against PostgreSQL: the unit of work, the skip path, the resume and the log
 * -------------------------------------------------------------------------- */

afterAll(async () => {
    // The whole suite shares one test database with its siblings, and `npm test`
    // runs them in band.
    await truncateFeatureTables();
});

describe('one food is one unit of work (SCRBLD-F08)', () => {
    beforeEach(async () => {
        await truncateFeatureTables();
    });

    it('commits the judgement, the counts and the cursor together', async () => {
        const food = await seedPassingFood(1);
        const harness = createHarness();

        const outcome = await runValidation(harness.deps);

        expect(outcome.alreadyCompleted).toBe(false);
        expect(outcome.unjudged).toBe(0);
        expect(await publicationStatusOf(food.id)).toBe('published');

        const row = await requireRunRow(harness.deps.options);
        expect(row.status).toBe('succeeded');
        expect(row.counts).toMatchObject({ considered: 1, judged: 1, published: 1 });
        expect(storedCursor(row)).toMatchObject({ nextIndex: 1, unjudged: [] });

        // THE ATOMICITY CLAIM, read off the statements as they ran: the food's
        // status write, its count delta and its cursor are one transaction, and
        // the settled cursor is written once after the sweep in its own.
        const statusWrite = harness.traced.writes.find(
            (write) => write.table === 'catalog_foods' && write.operation === 'updateMany' && write.id === food.id,
        );
        expect(statusWrite).toBeDefined();

        const cursorWrites = harness.traced.writes.filter(
            (write) => write.table === 'catalog_import_runs' && write.dataKeys.includes('cursor'),
        );
        const countWrites = harness.traced.writes.filter(
            (write) => write.table === 'catalog_import_runs' && write.dataKeys.includes('counts'),
        );

        // TWO cursor writes and no more: the per-food advance, then the settled
        // cursor written after the sweep. They are named by position because
        // the loop's write necessarily precedes the sweep's close.
        expect(cursorWrites).toHaveLength(2);
        const [perFoodCursorWrite, settledCursorWrite] = cursorWrites;

        // The atomicity claim itself, counted rather than sampled: EXACTLY ONE
        // cursor write shares the judgement's transaction, so a second per-food
        // advance fails here instead of hiding behind the settled one.
        expect(perFoodCursorWrite.transaction).toBe(statusWrite?.transaction);
        expect(cursorWrites.filter((write) => write.transaction === statusWrite?.transaction)).toHaveLength(1);

        // And the other one is the sweep's, not the food's: a transaction of its
        // own (`0` would mean none at all) rather than the judgement's, which is
        // what "written once after the sweep" means for a run that judged one
        // food in one transaction.
        expect(settledCursorWrite.transaction).not.toBe(statusWrite?.transaction);
        expect(settledCursorWrite.transaction).not.toBe(0);

        // The close writes counts too, in its own transaction; the per-food one
        // is the write that shares the judgement's.
        expect(countWrites.some((write) => write.transaction === statusWrite?.transaction)).toBe(true);
        expect(harness.traced.foodTransactions()).toBe(1);
    });

    it('leaves the status, the counts and the cursor untouched when the food transaction rolls back', async () => {
        const food = await seedPassingFood(1);
        const harness = createHarness({ hooks: { rollbackFoodTransaction: 1 } });

        const error = await rejectionOf(runValidation(harness.deps));

        expect(error).toBeInstanceOf(HarnessRollback);

        // All three, or none. The rollback happened after the judgement, the
        // count delta and the cursor had all been written inside the
        // transaction, so a stage that committed any of them separately would
        // show it here.
        expect(await publicationStatusOf(food.id)).toBe('candidate');
        expect(await historyOf(food.id)).toBeNull();

        const row = await requireRunRow(harness.deps.options);
        expect(row.status).toBe('running');
        expect(row.cursor).toBeNull();
        expect(row.counts.judged).toBeUndefined();
        expect(row.counts.published).toBeUndefined();
        expect(harness.reports).toEqual([]);
    });

    it.each([
        ['cursor', 'cursor'],
        ['counts', 'counts'],
    ] as const)('undoes the judgement when the run row refuses the %s write', async (_label, field) => {
        const food = await seedPassingFood(1);
        const harness = createHarness({ hooks: { failLedgerWrite: field } });

        const error = await rejectionOf(runValidation(harness.deps));

        expect(error).toBeInstanceOf(HarnessLedgerFailure);

        // THE WINDOW F08 CLOSES, asserted from the direction that tells the two
        // designs apart: with the cursor and the counts written in a transaction
        // of their own, the judgement below would be committed and durable while
        // the ledger said nothing had happened.
        expect(await publicationStatusOf(food.id)).toBe('candidate');
        expect(await historyOf(food.id)).toBeNull();

        const row = await requireRunRow(harness.deps.options);
        expect(row.status).toBe('running');
        expect(row.cursor).toBeNull();
        expect(row.counts.judged).toBeUndefined();
    });

    it('writes nothing at all in a dry run, and reports what it would have written', async () => {
        const food = await seedPassingFood(1);
        const options = optionsOf({ dryRun: true });
        const harness = createHarness({ options });

        const outcome = await runValidation(harness.deps);

        expect(outcome.counts).toMatchObject({ judged: 1, published: 1 });
        expect(await publicationStatusOf(food.id)).toBe('candidate');
        expect(await historyOf(food.id)).toBeNull();
        expect(await runRow(options)).toBeNull();
        expect(harness.traced.foodTransactions()).toBe(0);
        expect(harness.reports).toEqual([]);
        expect(harness.traced.writes).toEqual([]);
    });
});

describe('a row the pass could not judge (SCRBLD-F08)', () => {
    beforeEach(async () => {
        await truncateFeatureTables();
    });

    it('commits the skip, its cursor entry and its run-log entry together, and closes the run failed', async () => {
        const food = await seedPassingFood(1);
        const harness = createHarness({ hooks: { missCompareAndSet: new Set([food.id]) } });

        const outcome = await runValidation(harness.deps);

        expect(outcome.unjudged).toBe(1);
        expect(outcome.counts.raced).toBe(1);
        expect(await publicationStatusOf(food.id)).toBe('candidate');
        expect(await historyOf(food.id)).toBeNull();

        const row = await requireRunRow(harness.deps.options);
        // A pass that could not judge every row it considered is not a completed
        // judgement of its set, so a re-run retries this same row.
        expect(row.status).toBe('failed');
        expect(row.counts).toMatchObject({ raced: 1 });
        expect(storedCursor(row)).toMatchObject({ nextIndex: 1, unjudged: [0] });
        expect(row.log.map((entry) => entry.event)).toContain('food_not_judged');

        const report = onlyReport(harness);
        expect(report.skipped.raced).toEqual([food.sourceKey]);

        // The three records of one skipped row, in one commit.
        const ledgerWrites = harness.traced.writes.filter((write) => write.table === 'catalog_import_runs');
        const cursorWrite = ledgerWrites.find((write) => write.dataKeys.includes('cursor'));
        expect(cursorWrite).toBeDefined();
        expect(
            ledgerWrites.some(
                (write) => write.dataKeys.includes('log') && write.transaction === cursorWrite?.transaction,
            ),
        ).toBe(true);
        expect(
            ledgerWrites.some(
                (write) => write.dataKeys.includes('counts') && write.transaction === cursorWrite?.transaction,
            ),
        ).toBe(true);
    });

    it('counts a row deleted under the pass and points the next attempt back at it', async () => {
        const doomed = await seedPassingFood(1);
        const survivor = await seedPassingFood(2);

        const harness = createHarness({
            hooks: {
                // The one window in which a concurrent writer can delete the row
                // without queueing behind its FOR UPDATE lock: before the food's
                // transaction opens.
                beforeFoodTransaction: async (ordinal) => {
                    if (ordinal === 1) {
                        await prisma.catalog_foods.delete({ where: { id: doomed.id } });
                    }
                },
            },
        });

        const outcome = await runValidation(harness.deps);

        expect(outcome.counts.vanished).toBe(1);
        expect(outcome.unjudged).toBe(1);
        expect(await publicationStatusOf(survivor.id)).toBe('published');

        const row = await requireRunRow(harness.deps.options);
        expect(row.status).toBe('failed');
        expect(row.counts).toMatchObject({ vanished: 1, judged: 1, published: 1 });
        expect(storedCursor(row).unjudged).toEqual([0]);
        expect(onlyReport(harness).skipped.vanished).toEqual([doomed.sourceKey]);
    });
});

describe('a resumed pass reports the whole run (SCRBLD-F43)', () => {
    beforeEach(async () => {
        await truncateFeatureTables();
    });

    /**
     * Four rows, none of which changes the considered set when it is judged.
     *
     * That is deliberate and it is what makes this a RESUME rather than a
     * restart: the considered list is filtered by publication status, so a row
     * this pass rejects or quarantines drops out of it and the plan fingerprint
     * stops matching. All four publish — two of them carrying a review-tier
     * flag, which is what a USDA record does with one — so the second attempt
     * resumes the same work list and the report has to account for both halves.
     */
    const seedResumeSet = async (): Promise<{ id: string; sourceKey: string }[]> => [
        await seedPassingFood(1),
        await seedFlaggedFood(2),
        await seedPassingFood(3),
        await seedFlaggedFood(4),
    ];

    it('carries the per-check, review-flag and per-category figures across the interruption', async () => {
        const foods = await seedResumeSet();
        const options = optionsOf();

        const interrupted = createHarness({ options, hooks: { interruptBeforeFoodTransaction: 3 } });
        const error = await rejectionOf(runValidation(interrupted.deps));
        expect(error).toBeInstanceOf(HarnessInterruption);

        // Two foods judged and durable, and the cursor says so — with the
        // dimensions of those two judgements carried in it.
        const openRow = await requireRunRow(options);
        expect(openRow.status).toBe('running');
        expect(storedCursor(openRow)).toMatchObject({ nextIndex: 2 });
        expect(
            (storedCursor(openRow).tallies as { publishedByCategory: Record<string, number> }).publishedByCategory,
        ).toEqual({ [CATEGORY]: 2 });
        expect((storedCursor(openRow).tallies as { byCheck: Record<string, number> }).byCheck).toEqual({
            [CATALOG_CHECK_NAMES.OUT_OF_CATEGORY_RANGE]: 1,
        });
        expect(interrupted.reports).toEqual([]);

        const resumed = createHarness({ options });
        const outcome = await runValidation(resumed.deps);

        expect(outcome.alreadyCompleted).toBe(false);
        expect(outcome.unjudged).toBe(0);

        const report = onlyReport(resumed);

        // THE FIGURES THE FINDING IS ABOUT. Each covers the RUN's four foods,
        // not the two this invocation judged.
        expect(report.failedChecks).toEqual({ [CATALOG_CHECK_NAMES.OUT_OF_CATEGORY_RANGE]: 2 });
        expect(report.reviewFlags).toEqual({ [CATALOG_CHECK_NAMES.OUT_OF_CATEGORY_RANGE]: 2 });
        expect(report.coverage.byCategory[CATEGORY]).toEqual({
            published: 4,
            target: categoryPlan.publishedTarget,
            shortfall: categoryPlan.publishedTarget - 4,
        });
        expect(report.coverage.publishedActualTotal).toBe(4);
        // Every shortfall derived from them follows: only this category has
        // published rows, so the total is the plan's own sum less those four.
        expect(report.coverage.shortfallTotal).toBe(PUBLISHED_TARGET_SUM - 4);
        expect(report.counts).toMatchObject({ considered: 4, judged: 4, published: 4 });

        // And the invocation block still describes THIS attempt, which is what
        // makes the two scopes readable apart.
        expect(report.invocation).toMatchObject({
            resumed: true,
            restartedBecausePlanChanged: false,
            startIndex: 2,
            judged: 2,
            // THE FAST PATH, and the point of it: the cursor's tallies matched
            // the work list, so they were adopted and no record read was made.
            talliesRestoredFromCursor: true,
            talliesRebuiltFromRecords: false,
        });
        expect(report.invocation.figureScope).toMatchObject({
            counts: 'run',
            failedChecks: 'run',
            reviewFlags: 'run',
            'coverage.byCategory.published': 'run',
            // Restored from the cursor, so the advisory aggregates are the
            // run's too — the one figure a rebuild could not have given back.
            modelCalls: 'run',
            'invocation.judged': 'invocation',
            skipped: 'invocation',
        });
        expect(resumed.entriesFor('validation_dimensions_rebuilt')).toEqual([]);

        // NO ROW JUDGED TWICE: one history entry per food, and the run row's
        // own totals agree with the report.
        for (const food of foods) {
            expect(await historyOf(food.id)).toHaveLength(1);
            expect(await publicationStatusOf(food.id)).toBe('published');
        }

        const closedRow = await requireRunRow(options);
        expect(closedRow.status).toBe('succeeded');
        expect(closedRow.counts).toMatchObject({ considered: 4, judged: 4, published: 4 });
        expect(closedRow.id).toBe(openRow.id);
    });

    it('reports the whole run after its own judgements changed the considered set', async () => {
        // THE CASE THE FINDING IS REALLY ABOUT. Two of these four rows change
        // the considered set the moment they are judged: `rejected` leaves
        // `allRows` altogether, and `quarantined` is filtered out of
        // `considered` without `--revalidate-quarantined`. So the plan
        // fingerprint the second attempt computes cannot match the one the
        // first saved — which is ORDINARY judgement, not a plan change — and
        // the cursor's position, with the tallies beside it, is discarded. The
        // rows themselves are still skipped, by their own history, so a report
        // that started its figures over would state that a run which judged
        // four foods had judged two.
        const rejected = await seedRejectedFood(1);
        const quarantined = await seedQuarantinedFood(2);
        const flagged = await seedFlaggedFood(3);
        const passing = await seedPassingFood(4);
        const options = optionsOf();

        const interrupted = createHarness({ options, hooks: { interruptBeforeFoodTransaction: 3 } });
        expect(await rejectionOf(runValidation(interrupted.deps))).toBeInstanceOf(HarnessInterruption);

        // The first attempt judged the two rows whose outcomes move the set.
        expect(await publicationStatusOf(rejected.id)).toBe('rejected');
        expect(await publicationStatusOf(quarantined.id)).toBe('quarantined');
        const openRow = await requireRunRow(options);
        expect(openRow.status).toBe('running');
        expect(storedCursor(openRow)).toMatchObject({ nextIndex: 2 });

        const resumed = createHarness({ options });
        const outcome = await runValidation(resumed.deps);

        expect(outcome.unjudged).toBe(0);
        const report = onlyReport(resumed);

        // It DID restart the traversal — the positions were meaningless — and
        // it rebuilt the run's figures from the records rather than starting
        // them over.
        expect(report.invocation).toMatchObject({
            resumed: true,
            restartedBecausePlanChanged: true,
            startIndex: 0,
            judged: 2,
            talliesRestoredFromCursor: false,
            talliesRebuiltFromRecords: true,
        });
        const rebuiltLines = resumed.entriesFor('validation_dimensions_rebuilt');
        expect(rebuiltLines).toHaveLength(1);
        expect(rebuiltLines[0].fields).toMatchObject({ judgedFoods: 2 });

        // EVERY DIMENSION COVERS BOTH INVOCATIONS. The two reject-tier checks
        // and the quarantine-tier one come from records this invocation never
        // judged and, in the rejected row's case, from a row it cannot even
        // read; the review flag and the two published rows are its own.
        expect(report.failedChecks).toEqual({
            [CATALOG_CHECK_NAMES.MACRO_MASS_CEILING]: 1,
            [CATALOG_CHECK_NAMES.ENERGY_MACRO_MISMATCH]: 1,
            [CATALOG_CHECK_NAMES.MISSING_DENSITY]: 1,
            [CATALOG_CHECK_NAMES.OUT_OF_CATEGORY_RANGE]: 1,
        });
        expect(report.reviewFlags).toEqual({ [CATALOG_CHECK_NAMES.OUT_OF_CATEGORY_RANGE]: 1 });
        expect(report.coverage.byCategory[CATEGORY]).toEqual({
            published: 2,
            target: categoryPlan.publishedTarget,
            shortfall: categoryPlan.publishedTarget - 2,
        });
        expect(report.coverage.publishedActualTotal).toBe(2);
        expect(report.coverage.shortfallTotal).toBe(PUBLISHED_TARGET_SUM - 2);

        // `counts` totals the run too, a restart included: four judgements, one
        // of each disposition the fixtures produce. `considered` is the set this
        // invocation walked — the two rows still in it — because a set size is
        // not something to accumulate.
        expect(report.counts).toMatchObject({
            judged: 4,
            published: 2,
            quarantined: 1,
            rejected: 1,
            considered: 2,
        });
        expect(report.invocation.figureScope).toMatchObject({
            counts: 'run',
            failedChecks: 'run',
            reviewFlags: 'run',
            'coverage.byCategory.published': 'run',
            'coverage.shortfallTotal': 'run',
            // The one figure the rebuild cannot reach: a per-food record is not
            // a spend ledger, so the advisory aggregates are this invocation's
            // and the label says so instead of overstating them.
            modelCalls: 'invocation',
            'invocation.judged': 'invocation',
        });

        // NO ROW JUDGED TWICE, which is what makes the rebuilt figures a total
        // rather than a double count.
        for (const food of [rejected, quarantined, flagged, passing]) {
            expect(await historyOf(food.id)).toHaveLength(1);
        }

        const closedRow = await requireRunRow(options);
        expect(closedRow.id).toBe(openRow.id);
        expect(closedRow.status).toBe('succeeded');
        expect(closedRow.counts).toMatchObject({ judged: 4, published: 2, quarantined: 1, rejected: 1 });
    });

    it('rebuilds the figures for a resumed cursor that carries no tallies at all', async () => {
        // A cursor written by a release from before the tallies were persisted.
        // The fingerprint still matches, so the POSITION is trusted and the
        // rows this run judged are skipped — and the figures that would
        // otherwise be missing are derived from those rows' records.
        const foods = await seedResumeSet();
        const options = optionsOf();

        const interrupted = createHarness({ options, hooks: { interruptBeforeFoodTransaction: 3 } });
        expect(await rejectionOf(runValidation(interrupted.deps))).toBeInstanceOf(HarnessInterruption);

        const openRow = await requireRunRow(options);
        const stored = storedCursor(openRow);
        await prisma.catalog_import_runs.update({
            where: { id: openRow.id },
            data: {
                cursor: {
                    fingerprint: stored.fingerprint as string,
                    nextIndex: stored.nextIndex as number,
                    unjudged: [],
                },
            },
        });

        const resumed = createHarness({ options });
        const outcome = await runValidation(resumed.deps);

        expect(outcome.unjudged).toBe(0);
        const report = onlyReport(resumed);

        expect(report.invocation).toMatchObject({
            resumed: true,
            restartedBecausePlanChanged: false,
            startIndex: 2,
            judged: 2,
            talliesRestoredFromCursor: false,
            talliesRebuiltFromRecords: true,
        });

        // COMPLETE, not merely labelled partial: the two foods the first
        // attempt judged are accounted for by their records.
        expect(report.failedChecks).toEqual({ [CATALOG_CHECK_NAMES.OUT_OF_CATEGORY_RANGE]: 2 });
        expect(report.reviewFlags).toEqual({ [CATALOG_CHECK_NAMES.OUT_OF_CATEGORY_RANGE]: 2 });
        expect(report.coverage.byCategory[CATEGORY]).toEqual({
            published: 4,
            target: categoryPlan.publishedTarget,
            shortfall: categoryPlan.publishedTarget - 4,
        });
        expect(report.coverage.shortfallTotal).toBe(PUBLISHED_TARGET_SUM - 4);
        expect(report.counts).toMatchObject({ considered: 4, judged: 4, published: 4 });
        expect(report.invocation.figureScope).toMatchObject({
            counts: 'run',
            failedChecks: 'run',
            'coverage.byCategory.published': 'run',
            modelCalls: 'invocation',
        });

        for (const food of foods) {
            expect(await historyOf(food.id)).toHaveLength(1);
        }
    });

    it('reports this invocation\'s dimensions, and says so, when the graph client cannot be read back', async () => {
        // The one case a rebuild is impossible: a caller whose graph client
        // exposes no validation-record read (`ValidateDb.catalog_validation_records.findMany`
        // is optional for exactly this reason). The pass still resumes and still
        // judges the rest; what it must not do is claim a run-scoped figure it
        // could neither restore nor derive.
        await seedFlaggedFood(1);
        await seedFlaggedFood(2);
        const options = optionsOf();

        const interrupted = createHarness({ options, hooks: { interruptBeforeFoodTransaction: 2 } });
        expect(await rejectionOf(runValidation(interrupted.deps))).toBeInstanceOf(HarnessInterruption);

        const openRow = await requireRunRow(options);
        const stored = storedCursor(openRow);
        await prisma.catalog_import_runs.update({
            where: { id: openRow.id },
            data: {
                cursor: {
                    fingerprint: stored.fingerprint as string,
                    nextIndex: stored.nextIndex as number,
                    unjudged: [],
                },
            },
        });

        const resumed = createHarness({ options });
        const { findMany: _withheld, ...records } = resumed.deps.db.catalog_validation_records;
        const withoutRecordRead: ValidateDb = {
            ...resumed.deps.db,
            catalog_validation_records: records,
        };

        await runValidation({ ...resumed.deps, db: withoutRecordRead });

        const report = onlyReport(resumed);
        expect(report.invocation).toMatchObject({
            talliesRestoredFromCursor: false,
            talliesRebuiltFromRecords: false,
        });
        expect(report.invocation.figureScope).toMatchObject({
            counts: 'run',
            failedChecks: 'invocation',
            'coverage.byCategory.published': 'invocation',
        });
        expect(report.failedChecks).toEqual({ [CATALOG_CHECK_NAMES.OUT_OF_CATEGORY_RANGE]: 1 });
        expect(resumed.entriesFor('validation_dimensions_not_rebuilt')).toHaveLength(1);
    });
});

describe('the advisory review is logged in bounded form (OBSBE-F08)', () => {
    /**
     * The sample limit the stage applies per event kind. Named here as the
     * number the assertions are written against — the case seeds two more
     * reviewable foods than this, so both sides of the bound are exercised.
     */
    const SAMPLE_LIMIT = 5;
    const REVIEWABLE_FOODS = SAMPLE_LIMIT + 2;

    /**
     * How many per-food advisory events one reviewed food raises: its
     * reservation (`advisory_review_reserved`) and its outcome
     * (`advisory_review_recorded`, or `advisory_review_failed` /
     * `advisory_review_unusable` when the vendor or its answer fails). Each kind
     * is sampled independently, so the pass-wide sample and suppression totals
     * are this many times the per-kind figures.
     */
    const ADVISORY_EVENTS_PER_FOOD = 2;

    const reviewOptions = optionsOf({ review: true });

    /**
     * Every per-food advisory line this pass emitted at a NORMAL level, which is
     * the volume the finding is about and must now be empty.
     *
     * "Per-food" is read off the line itself — an advisory event carrying a
     * `sourceKey` — so a pass-wide announcement (`advisory_review_summary`, a
     * budget stop, a missing seam) is deliberately not caught by it.
     */
    const perFoodAdvisoryLinesAtNormalLevel = (
        harness: Harness,
    ): { level: LogLevel; fields: Record<string, unknown> }[] =>
        harness
            .entries()
            .map((fields, index) => ({ level: harness.lines[index].level, fields }))
            .filter(
                (entry) =>
                    typeof entry.fields.event === 'string' &&
                    entry.fields.event.startsWith('advisory_review_') &&
                    entry.fields.sourceKey !== undefined &&
                    entry.level !== 'debug',
            );

    const seedReviewableSet = async (): Promise<{ id: string; sourceKey: string }[]> => {
        const foods: { id: string; sourceKey: string }[] = [];
        for (let ordinal = 1; ordinal <= REVIEWABLE_FOODS; ordinal += 1) {
            foods.push(await seedReviewableFood(ordinal));
        }
        return foods;
    };

    beforeEach(async () => {
        await truncateFeatureTables();
    });

    it('keeps every per-food line out of the normal levels: debug samples, the rest suppressed, one summary', async () => {
        const foods = await seedReviewableSet();
        const harness = createHarness({
            options: reviewOptions,
            // Plausible for the first three, implausible after that, so
            // `confirmed` is a figure the summary has to carry rather than a
            // copy of `reviewed`.
            respond: (ordinal) => ({
                assessments: [
                    {
                        check: CATALOG_CHECK_NAMES.OUT_OF_CATEGORY_RANGE,
                        plausible: ordinal <= 3,
                        reason: 'the harness answered',
                    },
                ],
            }),
        });

        const outcome = await runValidation(harness.deps);

        expect(outcome.unjudged).toBe(0);
        expect(harness.modelCalls).toHaveLength(REVIEWABLE_FOODS);
        for (const food of foods) {
            expect(await publicationStatusOf(food.id)).toBe('quarantined');
        }

        // NO PER-FOOD ADVISORY LINE AT A NORMAL LEVEL. This is the finding: a
        // catalog-scale pass reviews thousands of foods, and a line per food at
        // info or warn is thousands of lines that duplicate what the validation
        // record retains permanently.
        expect(perFoodAdvisoryLinesAtNormalLevel(harness)).toEqual([]);

        // A HARD CAP ON WHAT IS EMITTED AT ALL, per event kind: the first few as
        // debug samples, the rest suppressed rather than demoted.
        const recorded = harness.entriesFor('advisory_review_recorded');
        expect(recorded).toHaveLength(SAMPLE_LIMIT);
        expect(recorded.filter((entry) => entry.level === 'debug')).toHaveLength(SAMPLE_LIMIT);
        expect(recorded.map((entry) => entry.fields.sample)).toEqual([1, 2, 3, 4, 5]);
        expect(harness.entriesFor('advisory_review_reserved')).toHaveLength(SAMPLE_LIMIT);

        // The aggregate, once, carrying what the per-food lines no longer repeat
        // — including how many lines were suppressed, so the operator learns
        // there was more than they were shown.
        const summaries = harness.entriesFor('advisory_review_summary');
        expect(summaries).toHaveLength(1);
        expect(summaries[0].level).toBe('info');
        expect(summaries[0].fields).toMatchObject({
            reserved: REVIEWABLE_FOODS,
            used: REVIEWABLE_FOODS,
            reviewed: REVIEWABLE_FOODS,
            confirmed: 3,
            failed: 0,
            skippedAfterStop: 0,
            stopReason: null,
            sampleLimit: SAMPLE_LIMIT,
            samplesEmitted: SAMPLE_LIMIT * ADVISORY_EVENTS_PER_FOOD,
            linesSuppressed: (REVIEWABLE_FOODS - SAMPLE_LIMIT) * ADVISORY_EVENTS_PER_FOOD,
        });

        // The detail the sampled-out lines would have carried is still on the
        // record, which is why sampling them is not a loss.
        const record = await prisma.catalog_validation_records.findUnique({
            where: { catalog_food_id: foods[REVIEWABLE_FOODS - 1].id },
            select: { llm_review: true },
        });
        expect(record?.llm_review).toMatchObject({
            advisory: true,
            model: REVIEW_MODEL,
            requested_checks: [CATALOG_CHECK_NAMES.OUT_OF_CATEGORY_RANGE],
        });

        const report = onlyReport(harness);
        expect(report.modelCalls).toMatchObject({
            enabled: true,
            reserved: REVIEWABLE_FOODS,
            used: REVIEWABLE_FOODS,
            reviewedFoods: REVIEWABLE_FOODS,
            confirmedFoods: 3,
            failedReviews: 0,
        });
    });

    it('keeps a failure visible through the summary alone, at warn, with no per-food warning', async () => {
        await seedReviewableSet();
        const harness = createHarness({
            options: reviewOptions,
            respond: () => {
                throw new Error('the harness vendor refused');
            },
        });

        await runValidation(harness.deps);

        // EVERY review failed, and not one of them warned about itself. With the
        // per-food warnings gone, the summary below is the ONLY normal-level
        // announcement that anything failed — which is why it must rise.
        expect(perFoodAdvisoryLinesAtNormalLevel(harness)).toEqual([]);

        const failed = harness.entriesFor('advisory_review_failed');
        expect(failed).toHaveLength(SAMPLE_LIMIT);
        expect(failed.filter((entry) => entry.level === 'debug')).toHaveLength(SAMPLE_LIMIT);

        const summaries = harness.entriesFor('advisory_review_summary');
        expect(summaries).toHaveLength(1);
        // A failure past the sample limit is still something the operator is
        // TOLD about rather than something they have to go looking for.
        expect(summaries[0].level).toBe('warn');
        expect(summaries[0].fields).toMatchObject({
            reserved: REVIEWABLE_FOODS,
            used: REVIEWABLE_FOODS,
            reviewed: 0,
            failed: REVIEWABLE_FOODS,
            stopReason: null,
            sampleLimit: SAMPLE_LIMIT,
            samplesEmitted: SAMPLE_LIMIT * ADVISORY_EVENTS_PER_FOOD,
            linesSuppressed: (REVIEWABLE_FOODS - SAMPLE_LIMIT) * ADVISORY_EVENTS_PER_FOOD,
        });
    });

    it('emits no advisory summary at all when the review was not enabled', async () => {
        await seedPassingFood(1);
        const harness = createHarness();

        await runValidation(harness.deps);

        expect(harness.entriesFor('advisory_review_summary')).toEqual([]);
        expect(harness.modelCalls).toEqual([]);
    });
});

describe('the plan fingerprint', () => {
    it('changes with the considered set, which is what a restart is decided on', () => {
        const policy = { categories: coveragePlan.categories, validationBounds: coveragePlan.validationBounds };
        const first = validationPlanFingerprint({
            coveragePlanVersion: coveragePlan.coveragePlanVersion,
            policy,
            consideredSourceKeys: ['usda:1', 'usda:2'],
        });
        const second = validationPlanFingerprint({
            coveragePlanVersion: coveragePlan.coveragePlanVersion,
            policy,
            consideredSourceKeys: ['usda:2'],
        });

        expect(first).not.toBe(second);
    });
});
