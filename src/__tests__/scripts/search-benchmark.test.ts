/**
 * The search benchmark runner — `scripts/search-benchmark.ts` — and the
 * fail-closed rules that decide what its report may claim.
 *
 * WHAT THIS FILE IS FOR. The artefact this runner writes,
 * `data/meal-planning/reports/latest/benchmark-report.json`, is THE acceptance
 * evidence for Agent Action Plan §0.9.3's search-quality requirement, and it is
 * read by people who never open the runner. Every rule below therefore protects
 * a claim a reader would otherwise take on trust:
 *
 *   * the figures describe the release the report names, and one committed
 *     catalog state rather than several (the release-binding and
 *     corpus-stability blocks);
 *   * a report calls itself acceptance evidence only when the run took the
 *     committed protocol, and a diagnostic run cannot overwrite the artefact
 *     the plan cites (the acceptance-standing block);
 *   * a threshold was compared against the measurement rather than against its
 *     rounded display form (the exact-threshold block);
 *   * a structural invariant that does not hold fails the run instead of being
 *     averaged away (the invariant block);
 *   * and "a second, independently loaded database reproduces this" is a
 *     checkable comparison rather than a procedure nobody ran (the
 *     cross-database block).
 *
 * HOW IT DRIVES THE STAGE. Through the exported seams only — `runBenchmark`
 * with a fake `db`, a fake `search`, a fake `readActiveRelease`, injected
 * `now`/`hrtime`/`readRepoFile` and an `outPath` under `os.tmpdir()`, plus the
 * pure decisions (`protocolDeviations`, `rateAtLeast`/`rateAtMost`,
 * `collectInvariantFailures`, `determinismFingerprint`, `parsePeerReport`,
 * `compareAcrossDatabases`, `pinPoolToSingleConnection`, `parseArgs`) called
 * directly. NO DATABASE IS NEEDED and none is touched: Rule
 * backend-architecture §11 asks for the rules to be provable without one, and
 * every rule here is a decision over values rather than a query.
 *
 * The one file this suite reads from the repository is
 * `data/meal-planning/catalog/releases/v1/manifest.json`, because the runner
 * digests it as a measurement condition; the release version in every fixture
 * is therefore `v1`. NOTHING under `data/` is written. The committed report path
 * appears in exactly one test, which asserts the run REFUSES before writing,
 * and that test is built so a regression makes it fail on a different refusal
 * rather than overwrite the artefact — see its own comment.
 *
 * WHAT IS DELIBERATELY NOT HERE. The relevance of the committed query set and
 * the behaviour of `catalog.service.searchPublishedFoods` belong to
 * `src/__tests__/api/catalog.test.ts` and `api/benchmark.test.ts` (the
 * synthetic-corpus suite, which is explicitly not acceptance evidence); the
 * catalog stage lock's own acquisition branches to `catalog-import.test.ts`;
 * release loading and its count verification to `catalog-load.test.ts`. This
 * suite asserts what the RUNNER does with those parts' answers.
 *
 * `scripts/lib/bootstrap.ts` loads transitively through the runner, which is
 * harmless: its `dotenv.config()` never overwrites a variable the environment
 * already sets, and `scripts/lib/dbGuard.ts`'s module-load enforcement is a
 * no-op under Jest because `argv[1]` is the Jest binary rather than a script.
 *
 * Run it with:
 *
 *   NODE_ENV=test ALLOW_DB_TRUNCATE=true \
 *     DATABASE_URL=postgresql://…@127.0.0.1:5433/<name>_test \
 *     npx jest src/__tests__/scripts/search-benchmark.test.ts --runInBand
 */
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { reportPath } from '../../../scripts/lib/manifest';
import type {
    CatalogReleaseManifest,
    SearchBenchmark,
    SearchBenchmarkQuery,
} from '../../../scripts/lib/manifest';
import {
    BenchmarkInputError,
    collectInvariantFailures,
    compareAcrossDatabases,
    compareCorpusCounts,
    corpusMovement,
    databaseRelationship,
    determinismFingerprint,
    parseArgs,
    parsePeerReport,
    peerReportLabel,
    pinPoolToSingleConnection,
    protocolDeviations,
    rateAtLeast,
    rateAtMost,
    resolveOutPath,
    runBenchmark,
} from '../../../scripts/search-benchmark';
import type {
    ActiveReleasePointer,
    BenchmarkDb,
    BenchmarkDeps,
    BenchmarkOutcome,
    BenchmarkReport,
    CorpusCounts,
    PaginationQueryOutcome,
    PeerReportSource,
    PoolPinOutcome,
    QueryResult,
    SearchPage,
} from '../../../scripts/search-benchmark';
import type { LogFields, ScriptLogger } from '../../../scripts/lib/logger';

// ---------------------------------------------------------------------------
// Fixtures and fakes.
// ---------------------------------------------------------------------------

/** The release the fixtures name; its manifest is the one the runner digests. */
const RELEASE = 'v1';

/**
 * A source file the ordering condition can be read back out of. The runner
 * greps the service's own ORDER BY rather than assuming the collation, so the
 * seam has to be fed something that clause is in.
 */
const CATALOG_SERVICE_SOURCE = [
    'const rows = await db.$queryRaw`',
    '    SELECT id FROM catalog_foods',
    '    ORDER BY rank DESC, display_name COLLATE "C" ASC, source_key COLLATE "C" ASC',
    '`;',
].join('\n');

const SCALARS: Readonly<Record<string, string>> = {
    'SELECT version()': 'PostgreSQL 16.15 on x86_64-pc-linux-gnu',
    'SHOW shared_buffers': '128MB',
    'SELECT datcollate FROM pg_database WHERE datname = current_database()': 'en_US.utf8',
    'SELECT oid FROM pg_database WHERE datname = current_database()': '16451',
    'SELECT system_identifier FROM pg_control_system()': '7300000000000000001',
};

interface FakeFood {
    readonly id: string;
    readonly source_key: string;
    readonly publication_status: string;
}

const ZERO_COUNTS: CorpusCounts = {
    publishedFoods: 3,
    aliases: 4,
    portions: 5,
    components: 0,
    validationRecords: 3,
    publishedIngredientDerived: 0,
};

/**
 * A structural stand-in for the Prisma client, with the counts held in a
 * mutable field so a test can move the corpus between the run's two readings
 * the way a concurrent `catalog-load` would.
 */
interface FakeDb extends BenchmarkDb {
    counts: CorpusCounts;
    readonly statements: string[];
}

const makeDb = (input: {
    readonly foods: readonly FakeFood[];
    readonly counts?: CorpusCounts;
    readonly unreadableStatements?: readonly string[];
    readonly scalars?: Readonly<Record<string, string>>;
}): FakeDb => {
    const statements: string[] = [];
    const scalars = input.scalars ?? SCALARS;
    const unreadable = new Set(input.unreadableStatements ?? []);

    const db: FakeDb = {
        counts: input.counts ?? ZERO_COUNTS,
        statements,
        $queryRawUnsafe: async <T = unknown>(statement: string): Promise<T> => {
            statements.push(statement);
            if (unreadable.has(statement)) {
                throw new Error('permission denied');
            }
            const value = scalars[statement];
            return (value === undefined ? [] : [{ value }]) as T;
        },
        catalog_foods: {
            findMany: async (args) => {
                const where = args.where as
                    | { source_key: { in: string[] } }
                    | { id: { in: string[] } };
                if ('source_key' in where) {
                    const wanted = new Set(where.source_key.in);
                    return input.foods.filter((food) => wanted.has(food.source_key)).map((food) => ({ ...food }));
                }
                const wantedIds = new Set(where.id.in);
                return input.foods.filter((food) => wantedIds.has(food.id)).map((food) => ({ ...food }));
            },
            count: async (args) =>
                args.where.nutrition_provenance === undefined
                    ? db.counts.publishedFoods
                    : db.counts.publishedIngredientDerived,
        },
        catalog_food_aliases: { count: async () => db.counts.aliases },
        catalog_food_portions: { count: async () => db.counts.portions },
        catalog_food_components: { count: async () => db.counts.components },
        catalog_validation_records: { count: async () => db.counts.validationRecords },
    };

    return db;
};

const makeLogger = (): ScriptLogger & { readonly events: Array<{ event: string; fields?: LogFields }> } => {
    const events: Array<{ event: string; fields?: LogFields }> = [];
    const logger: ScriptLogger & { readonly events: typeof events } = {
        events,
        debug: (event, fields) => events.push({ event, fields }),
        info: (event, fields) => events.push({ event, fields }),
        warn: (event, fields) => events.push({ event, fields }),
        error: (event, fields) => events.push({ event, fields }),
        child: () => logger,
    };
    return logger;
};

const PINNED: PoolPinOutcome = {
    effectiveConnectionLimit: 1,
    pinned: true,
    preexisting: false,
    note: 'pinned for the test',
};

const makeManifest = (counts: CatalogReleaseManifest['counts']): CatalogReleaseManifest => ({
    release_id: RELEASE,
    coverage_plan_version: 'v1',
    generated_at: '2026-01-01T00:00:00.000Z',
    produced_by: 'npm run catalog:release',
    files: [{ path: 'foods.jsonl', name: 'foods.jsonl', sha256: 'a'.repeat(64), row_count: 3, bytes: 300 }],
    counts,
    source_datasets: [{ name: 'usda_foundation', version: '2024-10-31', versions_present: ['2024-10-31'] }],
    model_versions: {
        generation_model: null,
        review_model: null,
        prompt_version: null,
        review_prompt_version: null,
    },
    coverage: { published_total: 3, shortfall_total: 0, categories: [] },
});

const MANIFEST_COUNTS: CatalogReleaseManifest['counts'] = {
    foods: 3,
    published_foods: 3,
    aliases: 4,
    portions: 5,
    components: 0,
    published_ingredient_derived: 0,
    validation_records: 3,
};

const query = (id: string, q: string, expected: readonly string[]): SearchBenchmarkQuery => ({
    id,
    q,
    kind: 'exact',
    expected,
});

const THREE_QUERIES: readonly SearchBenchmarkQuery[] = [
    query('q001', 'coffee', ['usda:1']),
    query('q002', 'tea', ['usda:2']),
    query('q003', 'milk', ['usda:3']),
];

const THREE_FOODS: readonly FakeFood[] = [
    { id: 'id-1', source_key: 'usda:1', publication_status: 'published' },
    { id: 'id-2', source_key: 'usda:2', publication_status: 'published' },
    { id: 'id-3', source_key: 'usda:3', publication_status: 'published' },
];

/** Bounds that pass on any corpus, so a test only fails for its own reason. */
const PERMISSIVE_THRESHOLDS: SearchBenchmark['thresholds'] = {
    topThreeHitRate: 0,
    topTenHitRate: 0,
    maxZeroResultRate: 1,
    p95LatencyMs: 10_000,
    latencyLimit: 25,
};

const makeBenchmark = (overrides: Partial<SearchBenchmark> = {}): SearchBenchmark => ({
    benchmarkVersion: 'v1',
    catalogRelease: RELEASE,
    thresholds: PERMISSIVE_THRESHOLDS,
    ordering: ['ts_rank DESC', 'display_name COLLATE "C" ASC', 'source_key COLLATE "C" ASC'],
    protocol: { warmupPasses: 1, timedPasses: 3, sequential: true, connections: 1, timing: 'in_process' },
    reportedConditions: [
        'catalogReleaseChecksum',
        'postgresVersion',
        'hostCpu',
        'hostMemory',
        'sharedBuffers',
        'warmCacheCondition',
        'orderingCollation',
        'databaseDefaultCollation',
    ],
    paginationCheck: { queryIds: [], limit: 25, pages: 3, singlePageLimit: 75 },
    queries: THREE_QUERIES,
    ...overrides,
});

const POINTER: ActiveReleasePointer = {
    releaseId: RELEASE,
    loadedAt: new Date('2026-02-01T10:00:00.000Z'),
    runId: '11111111-1111-4111-8111-111111111111',
};

/**
 * A search that answers each query with its own expected food at rank one, and
 * pages a single-item result set.
 */
const alwaysFirst = (): SearchPage => ({ items: [{ id: 'id-1' }], total: 1 });

/** Each query's own expected food first, so every query scores a top-3 hit. */
const expectedFirst = (benchmark: SearchBenchmark, foods: readonly FakeFood[]) => {
    const idByQuery = new Map(
        benchmark.queries.map((entry) => [
            entry.q,
            foods.find((food) => food.source_key === entry.expected[0])?.id ?? 'missing',
        ]),
    );
    return async (q: string): Promise<SearchPage> => {
        const id = idByQuery.get(q);
        return id === undefined ? { items: [], total: 0 } : { items: [{ id }], total: 1 };
    };
};

interface DepsOverrides extends Partial<BenchmarkDeps> {
    readonly db?: FakeDb;
}

/** A temporary directory per test, removed by the suite's afterEach. */
const tempDirectories: string[] = [];

const tempOutPath = (): string => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'soh-benchmark-'));
    tempDirectories.push(directory);
    return path.join(directory, 'benchmark-report.json');
};

const makeDeps = (overrides: DepsOverrides = {}): BenchmarkDeps & { readonly db: FakeDb } => {
    const benchmark = overrides.benchmark ?? makeBenchmark();
    const db = overrides.db ?? makeDb({ foods: THREE_FOODS });
    // One nanosecond per call pair unless a test supplies its own clock, so a
    // latency figure is deterministic and tiny rather than machine-dependent.
    // `BigInt(n)` rather than a bigint literal: tsconfig targets ES2016, which
    // the runner itself respects by only ever doing bigint arithmetic.
    let tick = BigInt(0);

    return {
        db,
        search: overrides.search ?? expectedFirst(benchmark, THREE_FOODS),
        readActiveRelease: overrides.readActiveRelease ?? (async () => POINTER),
        benchmark,
        releaseManifest: overrides.releaseManifest ?? makeManifest(MANIFEST_COUNTS),
        releaseVersion: overrides.releaseVersion ?? RELEASE,
        outPath: overrides.outPath ?? tempOutPath(),
        logger: overrides.logger ?? makeLogger(),
        now: overrides.now ?? (() => new Date('2026-02-02T12:00:00.000Z')),
        hrtime:
            overrides.hrtime ??
            (() => {
                tick += BigInt(1);
                return tick;
            }),
        timedPasses: overrides.timedPasses ?? benchmark.protocol.timedPasses,
        passesOverridden: overrides.passesOverridden ?? false,
        poolPin: overrides.poolPin ?? PINNED,
        stageLockHeld: overrides.stageLockHeld ?? true,
        peerReport: overrides.peerReport ?? null,
        readRepoFile: overrides.readRepoFile ?? (() => CATALOG_SERVICE_SOURCE),
    };
};

/** The refusal a synchronous, pure call is expected to make. */
const refusalFrom = (call: () => unknown): BenchmarkInputError => {
    try {
        call();
    } catch (error) {
        if (error instanceof BenchmarkInputError) {
            return error;
        }
        throw error;
    }
    throw new Error('expected the call to refuse, but it returned');
};

/** The refusal a call is expected to make, with its typed code. */
const refusalOf = async (run: Promise<unknown>): Promise<BenchmarkInputError> => {
    try {
        await run;
    } catch (error) {
        if (error instanceof BenchmarkInputError) {
            return error;
        }
        throw error;
    }
    throw new Error('expected the run to refuse, but it resolved');
};

afterEach(() => {
    for (const directory of tempDirectories.splice(0)) {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

// ---------------------------------------------------------------------------
// The run is bound to the active release.
// ---------------------------------------------------------------------------

describe('binding the run to the active catalog release', () => {
    it('refuses when no succeeded release load exists', async () => {
        const deps = makeDeps({ readActiveRelease: async () => null });

        const refusal = await refusalOf(runBenchmark(deps));

        expect(refusal.code).toBe('release_not_loaded');
        expect(refusal.detail).toContain(`expectedRelease=${RELEASE}`);
        expect(fs.existsSync(deps.outPath)).toBe(false);
    });

    it('refuses when the active release is not the one the query set names', async () => {
        const deps = makeDeps({
            readActiveRelease: async () => ({ ...POINTER, releaseId: 'v2' }),
        });

        const refusal = await refusalOf(runBenchmark(deps));

        expect(refusal.code).toBe('release_mismatch');
        expect(refusal.detail).toEqual(
            expect.arrayContaining(['activeRelease=v2', `expectedRelease=${RELEASE}`, `runId=${POINTER.runId}`]),
        );
        expect(fs.existsSync(deps.outPath)).toBe(false);
    });

    it('records the pointer as the corpus evidence when the release agrees', async () => {
        const deps = makeDeps();

        const outcome = await runBenchmark(deps);

        expect(outcome.report.corpus.activeRelease).toEqual({
            releaseId: RELEASE,
            loadedAt: POINTER.loadedAt.toISOString(),
            runId: POINTER.runId,
            matchesContract: true,
        });
        expect(outcome.report.corpus.countsAgree).toBe(true);
    });

    it('refuses a single disagreeing count, naming it with both values', async () => {
        const deps = makeDeps({
            db: makeDb({ foods: THREE_FOODS, counts: { ...ZERO_COUNTS, portions: 4 } }),
        });

        const refusal = await refusalOf(runBenchmark(deps));

        expect(refusal.code).toBe('release_counts_disagree');
        expect(refusal.detail).toEqual(['portions expected=5 observed=4']);
        expect(fs.existsSync(deps.outPath)).toBe(false);
    });

    it('still refuses an empty catalog under its own code', async () => {
        const deps = makeDeps({
            db: makeDb({ foods: THREE_FOODS, counts: { ...ZERO_COUNTS, publishedFoods: 0 } }),
        });

        const refusal = await refusalOf(runBenchmark(deps));

        expect(refusal.code).toBe('catalog_empty');
    });

    it('checks published_ingredient_derived only when the manifest states it', () => {
        const withoutOptional = compareCorpusCounts(
            { foods: 3, aliases: 4, portions: 5, components: 0, validation_records: 3 },
            { ...ZERO_COUNTS, publishedIngredientDerived: 9 },
        );

        expect(withoutOptional.map((check) => check.name)).not.toContain('published_ingredient_derived');
        expect(withoutOptional.every((check) => check.ok)).toBe(true);

        const withOptional = compareCorpusCounts(MANIFEST_COUNTS, {
            ...ZERO_COUNTS,
            publishedIngredientDerived: 9,
        });

        expect(withOptional).toEqual(
            expect.arrayContaining([
                { name: 'published_ingredient_derived', expected: 0, observed: 9, ok: false },
            ]),
        );
    });

    it('falls back to counts.foods when the manifest states no published_foods', () => {
        const checks = compareCorpusCounts(
            { foods: 3, aliases: 4, portions: 5, components: 0, validation_records: 3 },
            ZERO_COUNTS,
        );

        expect(checks[0]).toEqual({ name: 'published_foods', expected: 3, observed: 3, ok: true });
    });
});

// ---------------------------------------------------------------------------
// The corpus cannot move under the run.
// ---------------------------------------------------------------------------

describe('a corpus that moves while the run measures it', () => {
    it('refuses when the release load run id changes, and writes no report', async () => {
        let reads = 0;
        const deps = makeDeps({
            readActiveRelease: async () => {
                reads += 1;
                return reads === 1 ? POINTER : { ...POINTER, runId: '22222222-2222-4222-8222-222222222222' };
            },
        });

        const refusal = await refusalOf(runBenchmark(deps));

        expect(refusal.code).toBe('corpus_moved_during_run');
        expect(refusal.detail.join(' ')).toContain('activeRelease.runId');
        expect(fs.existsSync(deps.outPath)).toBe(false);
    });

    it('refuses when a count changes, and writes no report', async () => {
        const db = makeDb({ foods: THREE_FOODS });
        let reads = 0;
        const deps = makeDeps({
            db,
            readActiveRelease: async () => {
                reads += 1;
                if (reads > 1) {
                    db.counts = { ...db.counts, aliases: 5 };
                }
                return POINTER;
            },
        });

        const refusal = await refusalOf(runBenchmark(deps));

        expect(refusal.code).toBe('corpus_moved_during_run');
        expect(refusal.detail).toEqual(['counts.aliases 4 -> 5']);
        expect(fs.existsSync(deps.outPath)).toBe(false);
    });

    it('refuses when the pointer disappears mid-run', async () => {
        let reads = 0;
        const deps = makeDeps({
            readActiveRelease: async () => {
                reads += 1;
                return reads === 1 ? POINTER : null;
            },
        });

        const refusal = await refusalOf(runBenchmark(deps));

        expect(refusal.code).toBe('corpus_moved_during_run');
        expect(fs.existsSync(deps.outPath)).toBe(false);
    });

    it('records the two readings and the lock it held when nothing moved', async () => {
        const outcome = await runBenchmark(makeDeps());
        const stability = outcome.report.conditions.corpusStability;

        expect(stability.stageLock).toEqual({ held: true, stage: 'benchmark', mode: 'shared' });
        expect(stability.activeReleaseAtStart.runId).toBe(POINTER.runId);
        expect(stability.activeReleaseAfterRun.runId).toBe(POINTER.runId);
        expect(stability.countsReverified).toBe(true);
    });

    describe('corpusMovement', () => {
        it('reports nothing for two identical readings', () => {
            const unchanged = corpusMovement(
                { pointer: POINTER, counts: ZERO_COUNTS },
                { pointer: POINTER, counts: ZERO_COUNTS },
            );

            expect(unchanged).toEqual([]);
        });

        it('reports a changed release id, run id and count separately', () => {
            const moved = corpusMovement(
                { pointer: POINTER, counts: ZERO_COUNTS },
                {
                    pointer: { ...POINTER, releaseId: 'v2', runId: 'other' },
                    counts: { ...ZERO_COUNTS, publishedFoods: 4 },
                },
            );

            expect(moved).toEqual([
                `activeRelease.releaseId ${RELEASE} -> v2`,
                `activeRelease.runId ${POINTER.runId} -> other`,
                'counts.publishedFoods 3 -> 4',
            ]);
        });

        it('reports a pointer that vanished', () => {
            const moved = corpusMovement(
                { pointer: POINTER, counts: ZERO_COUNTS },
                { pointer: null, counts: ZERO_COUNTS },
            );

            expect(moved).toHaveLength(1);
            expect(moved[0]).toContain('activeRelease disappeared during the run');
        });
    });
});

// ---------------------------------------------------------------------------
// Acceptance standing.
// ---------------------------------------------------------------------------

describe('acceptance standing', () => {
    it('is acceptance evidence when the run deviated in no way', async () => {
        const outcome = await runBenchmark(makeDeps());

        expect(outcome.report.acceptanceEvidence.thisReportIsAcceptanceEvidence).toBe(true);
        expect(outcome.report.acceptanceEvidence.protocolDeviations).toEqual([]);
        expect(outcome.report.verdict.standing).toBe('acceptance_evidence');
    });

    it('is diagnostic only when --passes overrode the timed pass count', async () => {
        const outcome = await runBenchmark(makeDeps({ timedPasses: 1, passesOverridden: true }));

        expect(outcome.report.acceptanceEvidence.thisReportIsAcceptanceEvidence).toBe(false);
        expect(outcome.report.verdict.standing).toBe('diagnostic_only');
        expect(outcome.report.acceptanceEvidence.protocolDeviations.map((deviation) => deviation.code)).toEqual([
            'timed_passes_overridden',
        ]);
        expect(outcome.report.verdict.statement).toContain('diagnostic_only');
    });

    // The verdict statement is the sentence a reader stops at, so a clean
    // diagnostic run must not make the citation claim there and then take it
    // back in the standing note appended after it.
    it('claims acceptance citation in the verdict only when the run earned it', async () => {
        const outcome = await runBenchmark(makeDeps());

        expect(outcome.report.verdict.overall).toBe('pass');
        expect(outcome.report.verdict.statement).toContain(
            'this report may be cited as acceptance evidence for the common-food search requirement',
        );
        expect(outcome.report.verdict.statement).toContain('deviated from the committed protocol in no way');
    });

    it('makes no acceptance-citation claim in a clean diagnostic verdict', async () => {
        const outcome = await runBenchmark(makeDeps({ timedPasses: 1, passesOverridden: true }));
        const statement = outcome.report.verdict.statement;

        // Metrics clean — so this is the branch that used to claim citability.
        expect(outcome.report.verdict.overall).toBe('pass');
        expect(outcome.report.verdict.failedInvariants).toEqual([]);
        expect(statement).not.toMatch(/may be cited/);
        expect(statement).toContain('which were not the committed protocol');
        expect(statement).toContain('Its standing is diagnostic_only');
    });

    it('is diagnostic only when the connection limit could not be verified', async () => {
        const outcome = await runBenchmark(
            makeDeps({
                poolPin: {
                    effectiveConnectionLimit: null,
                    pinned: false,
                    preexisting: false,
                    note: 'unreadable for the test',
                },
            }),
        );

        expect(outcome.report.acceptanceEvidence.protocolDeviations.map((deviation) => deviation.code)).toEqual([
            'connection_limit_unverified',
        ]);
        expect(outcome.report.conditions.warmCacheCondition.connectionsVerified).toBe(false);
        expect(outcome.report.conditions.warmCacheCondition.connectionLimitSource).toBe('unverified');
        // Falls back to the contract's figure, and says that it did.
        expect(outcome.report.conditions.warmCacheCondition.connections).toBe(1);
    });

    it('is diagnostic only when the stage lock was not held', async () => {
        const outcome = await runBenchmark(makeDeps({ stageLockHeld: false }));

        expect(outcome.report.acceptanceEvidence.protocolDeviations.map((deviation) => deviation.code)).toEqual([
            'stage_lock_not_held',
        ]);
        expect(outcome.report.conditions.corpusStability.stageLock.held).toBe(false);
        expect(outcome.report.verdict.standing).toBe('diagnostic_only');
    });

    it('records the verified pool limit a run did not set', async () => {
        const outcome = await runBenchmark(
            makeDeps({
                poolPin: {
                    effectiveConnectionLimit: 1,
                    pinned: false,
                    preexisting: true,
                    note: 'already one for the test',
                },
            }),
        );

        expect(outcome.report.conditions.warmCacheCondition.connectionLimitSource).toBe(
            'preexisting_in_database_url',
        );
        expect(outcome.report.acceptanceEvidence.thisReportIsAcceptanceEvidence).toBe(true);
    });

    it('reports a pool wider than the contract as a mismatch and a wider connections figure', async () => {
        const outcome = await runBenchmark(
            makeDeps({
                poolPin: {
                    effectiveConnectionLimit: 8,
                    pinned: false,
                    preexisting: true,
                    note: 'eight for the test',
                },
            }),
        );

        expect(outcome.report.acceptanceEvidence.protocolDeviations.map((deviation) => deviation.code)).toEqual([
            'connection_limit_mismatch',
        ]);
        expect(outcome.report.conditions.warmCacheCondition.connections).toBe(8);
        expect(outcome.report.conditions.warmCacheCondition.connectionsVerified).toBe(true);
    });

    /**
     * The one test that names the committed artefact path. It is deliberately
     * built so that a regression CANNOT overwrite it: the fake pointer is null,
     * so a runner that failed to refuse on the output path would refuse on
     * `release_not_loaded` instead — before any measurement and long before any
     * write. The assertion on the code is therefore the whole test, and the
     * digest check beside it proves the file was left alone either way.
     */
    it('refuses to write the default artefact path from a deviating run', async () => {
        const committed = resolveOutPath(null);
        const digestOf = (file: string): string | null =>
            fs.existsSync(file) ? crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') : null;
        const before = digestOf(committed);

        const refusal = await refusalOf(
            runBenchmark(
                makeDeps({
                    outPath: committed,
                    timedPasses: 1,
                    passesOverridden: true,
                    readActiveRelease: async () => null,
                }),
            ),
        );

        expect(refusal.code).toBe('diagnostic_run_to_acceptance_path');
        expect(refusal.detail).toEqual(['timed_passes_overridden']);
        expect(refusal.message).toContain('--out');

        expect(digestOf(committed)).toBe(before);
    });

    it('lets a deviating run write an explicit path', async () => {
        const deps = makeDeps({ timedPasses: 1, passesOverridden: true });

        const outcome = await runBenchmark(deps);

        expect(fs.existsSync(deps.outPath)).toBe(true);
        expect(outcome.report.acceptanceEvidence.thisReportIsAcceptanceEvidence).toBe(false);
    });

    describe('protocolDeviations', () => {
        const contract = { warmupPasses: 1, timedPasses: 3, connections: 1 };

        it('returns nothing for the committed protocol', () => {
            expect(
                protocolDeviations({ contract, timedPasses: 3, poolPin: PINNED, stageLockHeld: true }),
            ).toEqual([]);
        });

        it('names every deviation of a run that deviates in every way', () => {
            const deviations = protocolDeviations({
                contract,
                timedPasses: 1,
                poolPin: { effectiveConnectionLimit: 4, pinned: false, preexisting: true, note: 'four' },
                stageLockHeld: false,
            });

            expect(deviations.map((deviation) => deviation.code)).toEqual([
                'timed_passes_overridden',
                'connection_limit_mismatch',
                'stage_lock_not_held',
            ]);
        });

        it('distinguishes an unverified limit from a mismatched one', () => {
            const unverified = protocolDeviations({
                contract,
                timedPasses: 3,
                poolPin: { effectiveConnectionLimit: null, pinned: false, preexisting: false, note: 'none' },
                stageLockHeld: true,
            });

            expect(unverified.map((deviation) => deviation.code)).toEqual(['connection_limit_unverified']);
        });
    });
});

// ---------------------------------------------------------------------------
// The pool pin.
// ---------------------------------------------------------------------------

describe('pinPoolToSingleConnection', () => {
    it('appends the limit when the URL carries none', () => {
        const env: NodeJS.ProcessEnv = { DATABASE_URL: 'postgresql://u:p@127.0.0.1:5433/soh_test' };

        const outcome = pinPoolToSingleConnection(env);

        expect(outcome).toMatchObject({ effectiveConnectionLimit: 1, pinned: true, preexisting: false });
        expect(env.DATABASE_URL).toBe('postgresql://u:p@127.0.0.1:5433/soh_test?connection_limit=1');
    });

    it('leaves an existing limit of one in place and reports it as preexisting', () => {
        const env: NodeJS.ProcessEnv = {
            DATABASE_URL: 'postgresql://u:p@127.0.0.1:5433/soh_test?connection_limit=1',
        };

        const outcome = pinPoolToSingleConnection(env);

        expect(outcome).toMatchObject({ effectiveConnectionLimit: 1, pinned: false, preexisting: true });
        expect(env.DATABASE_URL).toBe('postgresql://u:p@127.0.0.1:5433/soh_test?connection_limit=1');
    });

    it('reports a wider existing limit without rewriting the operator’s datasource', () => {
        const env: NodeJS.ProcessEnv = {
            DATABASE_URL: 'postgresql://u:p@127.0.0.1:5433/soh_test?connection_limit=8&sslmode=disable',
        };

        const outcome = pinPoolToSingleConnection(env);

        expect(outcome).toMatchObject({ effectiveConnectionLimit: 8, pinned: false, preexisting: true });
        expect(env.DATABASE_URL).toBe(
            'postgresql://u:p@127.0.0.1:5433/soh_test?connection_limit=8&sslmode=disable',
        );
    });

    // The defect this branch closes: the helper used to test for presence and
    // then read the FIRST occurrence with a single exec, while the driver put
    // the LAST one in force. `connection_limit=1&connection_limit=8` therefore
    // reported one verified connection — raising no deviation and leaving the
    // run's acceptance standing intact — while eight connections were actually
    // available, and the mirror URL reported eight while behaving as one.
    it('names no limit when the parameter is duplicated, in either order', () => {
        for (const url of [
            'postgresql://u:p@127.0.0.1:5433/soh_test?connection_limit=1&connection_limit=8',
            'postgresql://u:p@127.0.0.1:5433/soh_test?connection_limit=8&connection_limit=1',
        ]) {
            const env: NodeJS.ProcessEnv = { DATABASE_URL: url };

            const outcome = pinPoolToSingleConnection(env);

            expect(outcome).toMatchObject({
                effectiveConnectionLimit: null,
                pinned: false,
                preexisting: false,
            });
            expect(outcome.note).toContain('2 times');
            expect(outcome.note).toContain('undocumented parameter-precedence rule');
            // The operator's datasource is left exactly as it was found.
            expect(env.DATABASE_URL).toBe(url);
        }
    });

    it('counts a duplicate whose value is unparsable or empty as an occurrence', () => {
        const outcome = pinPoolToSingleConnection({
            DATABASE_URL: 'postgresql://u:p@127.0.0.1:5433/soh_test?connection_limit=&connection_limit=8',
        });

        expect(outcome).toMatchObject({ effectiveConnectionLimit: null, pinned: false, preexisting: false });
        expect(outcome.note).toContain('2 times');
    });

    it('turns a duplicated limit into a connection_limit_unverified deviation', () => {
        const poolPin = pinPoolToSingleConnection({
            DATABASE_URL: 'postgresql://u:p@127.0.0.1:5433/soh_test?connection_limit=1&connection_limit=8',
        });

        const deviations = protocolDeviations({
            contract: { warmupPasses: 1, timedPasses: 3, connections: 1 },
            timedPasses: 3,
            poolPin,
            stageLockHeld: true,
        });

        expect(deviations.map((deviation) => deviation.code)).toEqual(['connection_limit_unverified']);
    });

    it('reports an unparsable limit as unverified rather than as preexisting', () => {
        const env: NodeJS.ProcessEnv = {
            DATABASE_URL: 'postgresql://u:p@127.0.0.1:5433/soh_test?connection_limit=many',
        };

        const outcome = pinPoolToSingleConnection(env);

        expect(outcome).toMatchObject({ effectiveConnectionLimit: null, pinned: false, preexisting: false });
        expect(env.DATABASE_URL).toBe('postgresql://u:p@127.0.0.1:5433/soh_test?connection_limit=many');
    });

    it('reports an absent or empty URL as unverified', () => {
        expect(pinPoolToSingleConnection({})).toMatchObject({
            effectiveConnectionLimit: null,
            pinned: false,
            preexisting: false,
        });
        expect(pinPoolToSingleConnection({ DATABASE_URL: '' })).toMatchObject({
            effectiveConnectionLimit: null,
            pinned: false,
        });
    });

    it('never returns the URL it read', () => {
        const url = 'postgresql://secret:credential@127.0.0.1:5433/soh_test';

        const outcome = pinPoolToSingleConnection({ DATABASE_URL: url });

        expect(JSON.stringify(outcome)).not.toContain('secret');
        expect(JSON.stringify(outcome)).not.toContain('127.0.0.1');
    });

    // The note reaches the report and the log lines, so every branch of it is
    // held to the same rule: it may name a count and an integer limit, and
    // nothing that identifies the host, the account or the database.
    it('keeps every branch’s note free of the host, credential, port and database name', () => {
        const base = 'postgresql://secret:credential@db.internal.example:5433/soh_prod_like';
        const urls = [
            base,
            `${base}?connection_limit=1`,
            `${base}?connection_limit=8&sslmode=disable`,
            `${base}?connection_limit=many`,
            `${base}?connection_limit=1&connection_limit=8`,
        ];

        for (const url of [...urls, '']) {
            const { note } = pinPoolToSingleConnection({ DATABASE_URL: url });

            expect(note).not.toContain('@');
            expect(note).not.toContain('://');
            for (const secret of ['secret', 'credential', 'db.internal.example', '5433', 'soh_prod_like']) {
                expect(note).not.toContain(secret);
            }
        }
    });
});

// ---------------------------------------------------------------------------
// Thresholds are compared exactly.
// ---------------------------------------------------------------------------

describe('threshold comparison', () => {
    describe('rateAtLeast / rateAtMost', () => {
        it('fails a rate that rounds onto its floor from below', () => {
            // 2/3 = 0.666666…, which rounds to 0.667 and would clear 0.6667.
            expect(rateAtLeast(2, 3, 0.6667)).toBe(false);
        });

        it('passes a rate exactly on its floor', () => {
            expect(rateAtLeast(2, 4, 0.5)).toBe(true);
        });

        it('fails a rate that rounds onto its ceiling from above', () => {
            // 1/3 = 0.333333…, which rounds to 0.333 and would clear 0.3333.
            expect(rateAtMost(1, 3, 0.3333)).toBe(false);
        });

        it('passes a rate exactly on its ceiling', () => {
            expect(rateAtMost(1, 4, 0.25)).toBe(true);
        });

        it('treats an empty set as a rate of zero', () => {
            expect(rateAtLeast(0, 0, 0.9)).toBe(false);
            expect(rateAtMost(0, 0, 0.03)).toBe(true);
        });

        it('handles the committed bounds without floating-point drift', () => {
            expect(rateAtLeast(9, 10, 0.9)).toBe(true);
            expect(rateAtLeast(96, 100, 0.97)).toBe(false);
            expect(rateAtLeast(97, 100, 0.97)).toBe(true);
            expect(rateAtMost(3, 100, 0.03)).toBe(true);
            expect(rateAtMost(4, 100, 0.03)).toBe(false);
        });
    });

    it('fails a hit rate that rounds onto its bound, and reports both figures', async () => {
        const benchmark = makeBenchmark({
            thresholds: { ...PERMISSIVE_THRESHOLDS, topThreeHitRate: 0.6667 },
        });
        // Two of the three queries find their food; the third finds another.
        const search = async (q: string): Promise<SearchPage> =>
            q === 'milk' ? { items: [{ id: 'id-1' }], total: 1 } : (await expectedFirst(benchmark, THREE_FOODS)(q));

        const outcome = await runBenchmark(makeDeps({ benchmark, search }));
        const check = outcome.report.thresholds.checks.topThreeHitRate;

        expect(check.verdict).toBe('fail');
        expect(check.measured).toBe(0.667);
        expect(check.measuredExact).toBeCloseTo(2 / 3, 12);
        expect(check.measuredAsCount).toBe('2 of 3 queries');
        expect(outcome.report.verdict.overall).toBe('fail');
        expect(outcome.failures.map((failure) => failure.contractKey)).toEqual(['topThreeHitRate']);
    });

    it('fails a zero-result rate that rounds onto its ceiling', async () => {
        const benchmark = makeBenchmark({
            thresholds: { ...PERMISSIVE_THRESHOLDS, maxZeroResultRate: 0.3333 },
        });
        const findsNothing = async (q: string): Promise<SearchPage> =>
            q === 'milk' ? { items: [], total: 0 } : (await expectedFirst(benchmark, THREE_FOODS)(q));

        const outcome = await runBenchmark(makeDeps({ benchmark, search: findsNothing }));
        const check = outcome.report.thresholds.checks.maxZeroResultRate;

        expect(check.verdict).toBe('fail');
        expect(check.measured).toBe(0.333);
        expect(check.measuredExact).toBeCloseTo(1 / 3, 12);
        expect(outcome.report.rollups.zeroResultRateExact).toBeCloseTo(1 / 3, 12);
    });

    it('fails a p95 latency that rounds onto its bound', async () => {
        const benchmark = makeBenchmark({
            thresholds: { ...PERMISSIVE_THRESHOLDS, p95LatencyMs: 150 },
            protocol: { warmupPasses: 0, timedPasses: 1, sequential: true, connections: 1, timing: 'in_process' },
        });
        // Nearest-rank p95 over three samples is the largest of them. The
        // slowest call takes 150.0004 ms, which rounds to 150.000 and passed
        // before the comparison was made exact.
        const durationsNs = [BigInt(1_000_000), BigInt(2_000_000), BigInt(150_000_400)];
        let call = 0;
        let clock = BigInt(0);
        const hrtime = (): bigint => {
            if (call % 2 === 0) {
                clock += BigInt(1);
            } else {
                clock += durationsNs[Math.floor(call / 2) % durationsNs.length];
            }
            call += 1;
            return clock;
        };

        const outcome = await runBenchmark(makeDeps({ benchmark, timedPasses: 1, hrtime }));
        const check = outcome.report.thresholds.checks.p95LatencyMs;

        expect(outcome.report.latency.samples).toBe(3);
        expect(check.measured).toBe(150);
        expect(check.measuredExact).toBeGreaterThan(150);
        expect(check.verdict).toBe('fail');
    });

    it('states that the displayed rates are not the compared ones', async () => {
        const outcome = await runBenchmark(makeDeps());

        expect(outcome.report.rollups.rateBasis.displayDecimals).toBe(3);
        expect(outcome.report.rollups.rateBasis.comparisonScale).toBe(1_000_000);
        expect(outcome.report.rollups.topThreeHitCount).toBe(3);
        expect(outcome.report.rollups.perKind[0].topThreeHitCount).toBe(3);
    });
});

// ---------------------------------------------------------------------------
// Structural invariants fail the run.
// ---------------------------------------------------------------------------

describe('structural invariants', () => {
    it('fails the run when a rank moves between timed passes, and still writes the report', async () => {
        const benchmark = makeBenchmark();
        let coffeeCalls = 0;
        const search = async (q: string): Promise<SearchPage> => {
            if (q !== 'coffee') {
                return expectedFirst(benchmark, THREE_FOODS)(q);
            }
            coffeeCalls += 1;
            // Warm-up, then pass one at rank 1, then rank 2 from pass two on.
            return coffeeCalls <= 2
                ? { items: [{ id: 'id-1' }], total: 2 }
                : { items: [{ id: 'id-9' }, { id: 'id-1' }], total: 2 };
        };

        const deps = makeDeps({ benchmark, search });
        const outcome = await runBenchmark(deps);

        expect(outcome.invariantFailures.map((failure) => failure.code)).toEqual([
            'rank_unstable_across_timed_passes',
        ]);
        expect(outcome.report.verdict.overall).toBe('fail');
        expect(outcome.report.verdict.failedThresholds).toEqual([]);
        expect(outcome.report.diagnostics.rankInstability.ids).toEqual(['q001']);
        expect(outcome.report.rollups.rankStability.unstable).toBe(1);
        // Fail-closed: the artefact is written first, and only then does the
        // run report its failure.
        expect(fs.existsSync(deps.outPath)).toBe(true);
        const written = JSON.parse(fs.readFileSync(deps.outPath, 'utf8')) as BenchmarkReport;
        expect(written.verdict.failedInvariants[0].code).toBe('rank_unstable_across_timed_passes');
    });

    it('passes when every timed pass agrees', async () => {
        const outcome = await runBenchmark(makeDeps());

        expect(outcome.invariantFailures).toEqual([]);
        expect(outcome.report.verdict.overall).toBe('pass');
        expect(outcome.report.diagnostics.rankInstability.queries).toBe(0);
    });

    describe('collectInvariantFailures', () => {
        const cleanPagination = {
            perQuery: [] as readonly PaginationQueryOutcome[],
            queriesChecked: 0,
            queriesPassed: 0,
            duplicateIds: 0,
            missingIds: 0,
            threePageTraversals: 0,
            matchSetWidthRange: [0, 0] as readonly [number, number],
            outcome: 'pass' as const,
        };

        it('returns nothing when all three invariants hold', () => {
            expect(
                collectInvariantFailures({
                    pagination: cleanPagination,
                    unstableQueryIds: [],
                    crossDatabase: 'identical',
                }),
            ).toEqual([]);
        });

        it('raises the pagination invariant', () => {
            const failures = collectInvariantFailures({
                pagination: { ...cleanPagination, queriesChecked: 2, duplicateIds: 1, outcome: 'fail' },
                unstableQueryIds: [],
                crossDatabase: 'not_evaluated_by_a_single_run',
            });

            expect(failures.map((failure) => failure.code)).toEqual(['pagination_invariant_failed']);
        });

        it('names the unstable queries and caps the list', () => {
            const ids = Array.from({ length: 30 }, (_, index) => `q${index}`);

            const failures = collectInvariantFailures({
                pagination: cleanPagination,
                unstableQueryIds: ids,
                crossDatabase: 'identical',
            });

            expect(failures[0].code).toBe('rank_unstable_across_timed_passes');
            expect(failures[0].detail).toContain('q24');
            expect(failures[0].detail).not.toContain('q25,');
            expect(failures[0].detail).toContain('and 5 more');
        });

        it('raises a cross-database difference', () => {
            const failures = collectInvariantFailures({
                pagination: cleanPagination,
                unstableQueryIds: [],
                crossDatabase: 'differs',
            });

            expect(failures.map((failure) => failure.code)).toEqual(['cross_database_reproduction_differs']);
        });

        it('does not raise anything for a comparison nobody made', () => {
            expect(
                collectInvariantFailures({
                    pagination: cleanPagination,
                    unstableQueryIds: [],
                    crossDatabase: 'not_evaluated_by_a_single_run',
                }),
            ).toEqual([]);
        });

        // A comparison that established nothing did so BECAUSE this run's own
        // rank stability or pagination did not hold, and that fact is already
        // raised. A second code for it would count one failure twice and
        // describe it as a cross-database disagreement nobody found.
        it('raises only the underlying invariant when the comparison established nothing', () => {
            const failures = collectInvariantFailures({
                pagination: cleanPagination,
                unstableQueryIds: ['q001'],
                crossDatabase: 'not_established',
            });

            expect(failures.map((failure) => failure.code)).toEqual(['rank_unstable_across_timed_passes']);
        });
    });
});

// ---------------------------------------------------------------------------
// Portable page sequences and the determinism fingerprint.
// ---------------------------------------------------------------------------

describe('portable page sequences', () => {
    const paginated = makeBenchmark({
        paginationCheck: { queryIds: ['q001'], limit: 2, pages: 2, singlePageLimit: 4 },
    });

    const pagingSearch = async (q: string, page: number, limit: number): Promise<SearchPage> => {
        if (q !== 'coffee') {
            return expectedFirst(paginated, THREE_FOODS)(q);
        }
        const all = [{ id: 'id-1' }, { id: 'id-2' }, { id: 'id-3' }];
        return { items: all.slice((page - 1) * limit, (page - 1) * limit + limit), total: all.length };
    };

    it('records each pagination query as release-stable source keys', async () => {
        const outcome = await runBenchmark(makeDeps({ benchmark: paginated, search: pagingSearch }));
        const perQuery = outcome.report.paginationCheck.perQuery[0];

        expect(perQuery.pageSourceKeys).toEqual(['usda:1', 'usda:2', 'usda:3']);
        expect(perQuery.referenceSourceKeys).toEqual(['usda:1', 'usda:2', 'usda:3']);
        expect(outcome.report.paginationCheck.outcome).toBe('pass');
    });

    it('refuses when a paged id cannot be mapped back to a source key', async () => {
        const strayPaging = async (q: string, page: number, limit: number): Promise<SearchPage> =>
            q === 'coffee' ? { items: [{ id: 'id-stray' }], total: 1 } : pagingSearch(q, page, limit);

        const deps = makeDeps({ benchmark: paginated, search: strayPaging });
        const refusal = await refusalOf(runBenchmark(deps));

        expect(refusal.code).toBe('portable_ids_unresolved');
        expect(refusal.detail).toEqual(['id-stray']);
        expect(fs.existsSync(deps.outPath)).toBe(false);
    });

    describe('determinismFingerprint', () => {
        const result = (id: string, rank: number | null, matchedSourceKey: string | null): QueryResult => ({
            id,
            q: id,
            kind: 'exact',
            expectedSourceKeys: ['usda:1'],
            matchedSourceKey,
            rank,
            rankInFullResultSet: rank,
            matchSetTotal: 3,
            outcome: rank === null ? 'not_retrieved' : 'top3',
            rankStableAcrossPasses: true,
        });

        const pagination = (id: string, keys: readonly string[]): PaginationQueryOutcome => ({
            id,
            q: id,
            matchSetTotal: keys.length,
            pagedIds: keys.length,
            referenceIds: keys.length,
            expectedIds: keys.length,
            pagesTraversed: 1,
            sequenceMatches: true,
            duplicates: 0,
            missing: 0,
            pageSourceKeys: keys,
            referenceSourceKeys: keys,
        });

        it('is equal for two identical result sets', () => {
            const a = determinismFingerprint([result('q001', 1, 'usda:1')], [pagination('q001', ['usda:1'])]);
            const b = determinismFingerprint([result('q001', 1, 'usda:1')], [pagination('q001', ['usda:1'])]);

            expect(a).toBe(b);
            expect(a).toMatch(/^[0-9a-f]{64}$/);
        });

        it('is equal when only the input order differs', () => {
            const ordered = determinismFingerprint(
                [result('q001', 1, 'usda:1'), result('q002', 2, 'usda:2')],
                [pagination('q001', ['usda:1']), pagination('q002', ['usda:2'])],
            );
            const shuffled = determinismFingerprint(
                [result('q002', 2, 'usda:2'), result('q001', 1, 'usda:1')],
                [pagination('q002', ['usda:2']), pagination('q001', ['usda:1'])],
            );

            expect(shuffled).toBe(ordered);
        });

        it('differs when one rank moves', () => {
            const before = determinismFingerprint([result('q001', 1, 'usda:1')], []);
            const after = determinismFingerprint([result('q001', 2, 'usda:1')], []);

            expect(after).not.toBe(before);
        });

        it('differs when one page sequence moves', () => {
            const before = determinismFingerprint([], [pagination('q001', ['usda:1', 'usda:2'])]);
            const after = determinismFingerprint([], [pagination('q001', ['usda:2', 'usda:1'])]);

            expect(after).not.toBe(before);
        });

        // Within-run stability is part of the measurement: the same rank held
        // across three passes and the same rank that moved between them are not
        // the same observation, so they must not share a fingerprint.
        it('differs when only the within-run rank stability changes', () => {
            const stable = determinismFingerprint([result('q001', 1, 'usda:1')], []);
            const unstable = determinismFingerprint(
                [{ ...result('q001', 1, 'usda:1'), rankStableAcrossPasses: false }],
                [],
            );

            expect(unstable).not.toBe(stable);
        });
    });
});

// ---------------------------------------------------------------------------
// Cross-database reproduction.
// ---------------------------------------------------------------------------

describe('cross-database reproduction', () => {
    const THIS_IDENTITY = { databaseOid: 16451, systemIdentifier: '7300000000000000001', statement: 'this' };
    const PEER_IDENTITY = { databaseOid: 16999, systemIdentifier: '7300000000000000002', statement: 'peer' };

    const result = (id: string, rank: number | null): QueryResult => ({
        id,
        q: id,
        kind: 'exact',
        expectedSourceKeys: ['usda:1'],
        matchedSourceKey: rank === null ? null : 'usda:1',
        rank,
        rankInFullResultSet: rank,
        matchSetTotal: 2,
        outcome: rank === null ? 'not_retrieved' : 'top3',
        rankStableAcrossPasses: true,
    });

    const pagination = (id: string, keys: readonly string[]): PaginationQueryOutcome => ({
        id,
        q: id,
        matchSetTotal: keys.length,
        pagedIds: keys.length,
        referenceIds: keys.length,
        expectedIds: keys.length,
        pagesTraversed: 1,
        sequenceMatches: true,
        duplicates: 0,
        missing: 0,
        pageSourceKeys: keys,
        referenceSourceKeys: keys,
    });

    const peerOf = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
        stage: 'search-benchmark',
        reportVersion: 'v1',
        benchmarkVersion: 'v1',
        catalogRelease: RELEASE,
        generatedAt: '2026-02-02T13:00:00.000Z',
        determinismFingerprint: determinismFingerprint([result('q001', 1)], [pagination('q001', ['usda:1'])]),
        verdict: { standing: 'acceptance_evidence' },
        corpus: { publishedFoods: 3 },
        // A peer is only comparable when it, too, was the committed protocol
        // with its own invariants holding, so the eligibility fields are part
        // of the default fixture and each test that denies one overrides it.
        rollups: { rankStability: { unstable: 0 } },
        conditions: {
            postgresVersion: 'PostgreSQL 16.15',
            databaseDefaultCollation: 'en_US.utf8',
            databaseIdentity: {
                databaseOid: PEER_IDENTITY.databaseOid,
                systemIdentifier: PEER_IDENTITY.systemIdentifier,
            },
        },
        results: [{ id: 'q001', rank: 1, rankInFullResultSet: 1, matchSetTotal: 2, matchedSourceKey: 'usda:1' }],
        paginationCheck: {
            outcome: 'pass',
            perQuery: [{ id: 'q001', pageSourceKeys: ['usda:1'], referenceSourceKeys: ['usda:1'] }],
        },
        ...overrides,
    });

    // Typed so `pathKind` narrows to its union rather than to `string`, and
    // named as a file rather than as a path: what reaches a committed artefact
    // is the label, never the absolute path the peer was read from.
    const sourceOf = (raw: Record<string, unknown>): PeerReportSource => ({
        path: 'second-report.json',
        pathKind: 'name_only',
        sha256: 'b'.repeat(64),
        raw,
    });

    const expected = { benchmarkVersion: 'v1', catalogRelease: RELEASE };

    describe('parsePeerReport', () => {
        it('accepts a report of the same contract', () => {
            const peer = parsePeerReport(sourceOf(peerOf()), expected);

            expect(peer.standing).toBe('acceptance_evidence');
            expect(peer.databaseOid).toBe(PEER_IDENTITY.databaseOid);
            expect(peer.results).toHaveLength(1);
            expect(peer.pagination[0].pageSourceKeys).toEqual(['usda:1']);
            expect(peer.sha256).toBe('b'.repeat(64));
        });

        it('refuses a file that is not a JSON object', () => {
            const refusal = (() => {
                try {
                    parsePeerReport(sourceOf([] as unknown as Record<string, unknown>), expected);
                } catch (error) {
                    return error as BenchmarkInputError;
                }
                throw new Error('expected a refusal');
            })();

            expect(refusal.code).toBe('compare_report_unreadable');
        });

        it('refuses another stage’s report', () => {
            expect(() => parsePeerReport(sourceOf(peerOf({ stage: 'catalog-load' })), expected)).toThrow(
                /stage\/reportVersion/,
            );
        });

        it('refuses another benchmark version or release under its own code', () => {
            const wrongRelease = (() => {
                try {
                    parsePeerReport(sourceOf(peerOf({ catalogRelease: 'v2' })), expected);
                } catch (error) {
                    return error as BenchmarkInputError;
                }
                throw new Error('expected a refusal');
            })();

            expect(wrongRelease.code).toBe('compare_report_mismatched_contract');
            expect(wrongRelease.detail).toContain('peerCatalogRelease=v2');
        });

        it('refuses a report with no database identity, which cannot evidence a second database', () => {
            const refusal = (() => {
                try {
                    parsePeerReport(
                        sourceOf(
                            peerOf({
                                conditions: {
                                    postgresVersion: 'PostgreSQL 16.15',
                                    databaseDefaultCollation: 'en_US.utf8',
                                },
                            }),
                        ),
                        expected,
                    );
                } catch (error) {
                    return error as BenchmarkInputError;
                }
                throw new Error('expected a refusal');
            })();

            expect(refusal.code).toBe('compare_report_unreadable');
            expect(refusal.message).toContain('databaseIdentity');
        });

        // Both eligibility fields are required rather than defaulted: every
        // report this runner writes carries them, and defaulting a missing one
        // to "stable"/"pass" is the fail-open direction the check exists to
        // close.
        it('refuses a report that does not record its own rank stability', () => {
            const { rollups: _omitted, ...withoutRollups } = peerOf();

            const refusal = refusalFrom(() => parsePeerReport(sourceOf(withoutRollups), expected));

            expect(refusal.code).toBe('compare_report_unreadable');
            expect(refusal.message).toContain('rollups');
        });

        it('refuses a report whose rank stability count is not a number', () => {
            const refusal = refusalFrom(() =>
                parsePeerReport(sourceOf(peerOf({ rollups: { rankStability: {} } })), expected),
            );

            expect(refusal.code).toBe('compare_report_unreadable');
            expect(refusal.message).toContain('unstable');
        });

        it('refuses a report that does not record its pagination verdict', () => {
            const refusal = refusalFrom(() =>
                parsePeerReport(
                    sourceOf(
                        peerOf({
                            paginationCheck: {
                                perQuery: [
                                    { id: 'q001', pageSourceKeys: ['usda:1'], referenceSourceKeys: ['usda:1'] },
                                ],
                            },
                        }),
                    ),
                    expected,
                ),
            );

            expect(refusal.code).toBe('compare_report_unreadable');
            expect(refusal.message).toContain('outcome');
        });

        it('refuses a report whose page sequences are not portable keys', () => {
            expect(() =>
                parsePeerReport(
                    sourceOf(
                        peerOf({
                            paginationCheck: {
                                outcome: 'pass',
                                perQuery: [{ id: 'q001', pageSourceKeys: [1, 2] }],
                            },
                        }),
                    ),
                    expected,
                ),
            ).toThrow(/pageSourceKeys/);
        });
    });

    describe('compareAcrossDatabases', () => {
        const thisRun = {
            determinismFingerprint: determinismFingerprint(
                [result('q001', 1)],
                [pagination('q001', ['usda:1'])],
            ),
            results: [result('q001', 1)],
            pagination: [pagination('q001', ['usda:1'])],
            databaseIdentity: THIS_IDENTITY,
            releaseVersion: RELEASE,
            // The eligible, invariant-holding shape of this run; the tests
            // below that deny one of the three override it explicitly.
            protocolDeviationCodes: [] as readonly string[],
            unstableQueryIds: [] as readonly string[],
            paginationOutcome: 'pass' as const,
        };

        it('records not_evaluated_by_a_single_run when no peer was given', () => {
            const comparison = compareAcrossDatabases({ ...thisRun, peer: null });

            expect(comparison.outcome).toBe('not_evaluated_by_a_single_run');
            expect(comparison.comparedWith).toBeNull();
            expect(comparison.ranks).toBeNull();
            expect(comparison.pageSequences).toBeNull();
            expect(comparison.fingerprintsMatch).toBeNull();
            expect(comparison.howToReproduce.join(' ')).toContain('--compare-with');
        });

        it('records identical when every rank and page sequence agrees', () => {
            const comparison = compareAcrossDatabases({
                ...thisRun,
                peer: parsePeerReport(sourceOf(peerOf()), expected),
            });

            expect(comparison.outcome).toBe('identical');
            expect(comparison.fingerprintsMatch).toBe(true);
            expect(comparison.ranks).toMatchObject({ queriesCompared: 1, identical: 1, differingCount: 0 });
            expect(comparison.pageSequences).toMatchObject({ queriesCompared: 1, identical: 1 });
            expect(comparison.comparedWith).toMatchObject({
                path: 'second-report.json',
                pathKind: 'name_only',
                sha256: 'b'.repeat(64),
                databaseOid: PEER_IDENTITY.databaseOid,
                standing: 'acceptance_evidence',
            });
        });

        it('records a differing rank with both sides of it', () => {
            const peer = parsePeerReport(
                sourceOf(
                    peerOf({
                        results: [
                            {
                                id: 'q001',
                                rank: 2,
                                rankInFullResultSet: 2,
                                matchSetTotal: 2,
                                matchedSourceKey: 'usda:1',
                            },
                        ],
                        // The peer's own fingerprint, over its own ranks, which
                        // is what makes this fixture a report that second
                        // database would really have written.
                        determinismFingerprint: determinismFingerprint(
                            [result('q001', 2)],
                            [pagination('q001', ['usda:1'])],
                        ),
                    }),
                ),
                expected,
            );

            const comparison = compareAcrossDatabases({ ...thisRun, peer });

            expect(comparison.outcome).toBe('differs');
            expect(comparison.fingerprintsMatch).toBe(false);
            expect(comparison.ranks?.differing).toEqual([
                {
                    id: 'q001',
                    thisRank: 1,
                    peerRank: 2,
                    thisRankInFullResultSet: 1,
                    peerRankInFullResultSet: 2,
                    thisMatchSetTotal: 2,
                    peerMatchSetTotal: 2,
                    thisMatchedSourceKey: 'usda:1',
                    peerMatchedSourceKey: 'usda:1',
                },
            ]);
        });

        it('records a differing page sequence with the index it diverged at', () => {
            const peer = parsePeerReport(
                sourceOf(
                    peerOf({
                        paginationCheck: {
                            outcome: 'pass',
                            perQuery: [
                                { id: 'q001', pageSourceKeys: ['usda:2'], referenceSourceKeys: ['usda:1'] },
                            ],
                        },
                    }),
                ),
                expected,
            );

            const comparison = compareAcrossDatabases({ ...thisRun, peer });

            expect(comparison.outcome).toBe('differs');
            expect(comparison.pageSequences?.differing).toEqual([
                {
                    id: 'q001',
                    sequence: 'page',
                    firstDivergingIndex: 0,
                    thisSourceKey: 'usda:1',
                    peerSourceKey: 'usda:2',
                },
            ]);
        });

        it('treats a shorter sequence as diverging at the first missing position', () => {
            const peer = parsePeerReport(
                sourceOf(
                    peerOf({
                        paginationCheck: {
                            outcome: 'pass',
                            perQuery: [{ id: 'q001', pageSourceKeys: [], referenceSourceKeys: ['usda:1'] }],
                        },
                    }),
                ),
                expected,
            );

            const comparison = compareAcrossDatabases({ ...thisRun, peer });

            expect(comparison.pageSequences?.differing[0]).toMatchObject({
                firstDivergingIndex: 0,
                thisSourceKey: 'usda:1',
                peerSourceKey: null,
            });
        });

        it('separates a query only one of the two reports scored', () => {
            const peer = parsePeerReport(
                sourceOf(
                    peerOf({
                        results: [
                            {
                                id: 'q404',
                                rank: 1,
                                rankInFullResultSet: 1,
                                matchSetTotal: 2,
                                matchedSourceKey: 'usda:1',
                            },
                        ],
                    }),
                ),
                expected,
            );

            const comparison = compareAcrossDatabases({ ...thisRun, peer });

            expect(comparison.outcome).toBe('differs');
            expect(comparison.ranks?.queriesOnlyInThisRun).toEqual(['q001']);
            expect(comparison.ranks?.queriesOnlyInComparedReport).toEqual(['q404']);
        });

        it('refuses a comparison of one database with itself', () => {
            const peer = parsePeerReport(
                sourceOf(
                    peerOf({
                        conditions: {
                            postgresVersion: 'PostgreSQL 16.15',
                            databaseDefaultCollation: 'en_US.utf8',
                            databaseIdentity: {
                                databaseOid: THIS_IDENTITY.databaseOid,
                                systemIdentifier: THIS_IDENTITY.systemIdentifier,
                            },
                        },
                    }),
                ),
                expected,
            );

            const refusal = (() => {
                try {
                    compareAcrossDatabases({ ...thisRun, peer });
                } catch (error) {
                    return error as BenchmarkInputError;
                }
                throw new Error('expected a refusal');
            })();

            expect(refusal.code).toBe('compare_report_same_database');
        });

        // An identity nobody could read is not evidence of a second database:
        // the same file compared with itself reads exactly like this, and
        // concluding `identical` from it would publish a self-comparison as the
        // §0.9.3 second-database evidence.
        it('refuses a pair of identities that establishes neither sameness nor distinctness', () => {
            const peer = parsePeerReport(
                sourceOf(
                    peerOf({
                        conditions: {
                            postgresVersion: 'PostgreSQL 16.15',
                            databaseDefaultCollation: 'en_US.utf8',
                            databaseIdentity: { databaseOid: null, systemIdentifier: null },
                        },
                    }),
                ),
                expected,
            );

            const refusal = (() => {
                try {
                    compareAcrossDatabases({
                        ...thisRun,
                        databaseIdentity: { databaseOid: null, systemIdentifier: null, statement: 'unreadable' },
                        peer,
                    });
                } catch (error) {
                    return error as BenchmarkInputError;
                }
                throw new Error('expected a refusal');
            })();

            expect(refusal.code).toBe('compare_report_identity_unverifiable');
            expect(refusal.detail).toEqual([
                'thisRun.systemIdentifier',
                'thisRun.databaseOid',
                'comparedReport.systemIdentifier',
                'comparedReport.databaseOid',
            ]);
            expect(refusal.message).toContain('pg_control_system()');
        });

        it('names only the unreadable side when the other side reads', () => {
            const peer = parsePeerReport(
                sourceOf(
                    peerOf({
                        conditions: {
                            postgresVersion: 'PostgreSQL 16.15',
                            databaseDefaultCollation: 'en_US.utf8',
                            databaseIdentity: { databaseOid: null, systemIdentifier: PEER_IDENTITY.systemIdentifier },
                        },
                    }),
                ),
                expected,
            );

            const refusal = (() => {
                try {
                    compareAcrossDatabases({ ...thisRun, peer });
                } catch (error) {
                    return error as BenchmarkInputError;
                }
                throw new Error('expected a refusal');
            })();

            expect(refusal.code).toBe('compare_report_identity_unverifiable');
            expect(refusal.detail).toEqual(['comparedReport.databaseOid']);
        });

        // Eligibility, condition by condition. `identical` claims the ordering
        // is a property of the release, and neither side can contribute to
        // that claim unless it measured the committed protocol with its own
        // invariants holding. All four facts below are INPUTS — recorded in
        // the peer's file, or known from this run's options before a query is
        // issued — so they refuse rather than producing an outcome.
        it('refuses a peer that is not acceptance evidence', () => {
            const peer = parsePeerReport(sourceOf(peerOf({ verdict: { standing: 'diagnostic_only' } })), expected);

            const refusal = refusalFrom(() => compareAcrossDatabases({ ...thisRun, peer }));

            expect(refusal.code).toBe('compare_report_not_protocol_eligible');
            expect(refusal.detail).toEqual(['comparedReport.standing=diagnostic_only']);
        });

        it('refuses a peer whose own ranks moved between its timed passes', () => {
            const peer = parsePeerReport(
                sourceOf(peerOf({ rollups: { rankStability: { unstable: 2 } } })),
                expected,
            );

            const refusal = refusalFrom(() => compareAcrossDatabases({ ...thisRun, peer }));

            expect(refusal.code).toBe('compare_report_not_protocol_eligible');
            expect(refusal.detail).toEqual(['comparedReport.unstableQueries=2']);
        });

        it('refuses a peer whose pagination check failed', () => {
            const peer = parsePeerReport(
                sourceOf(
                    peerOf({
                        paginationCheck: {
                            outcome: 'fail',
                            perQuery: [{ id: 'q001', pageSourceKeys: ['usda:1'], referenceSourceKeys: ['usda:1'] }],
                        },
                    }),
                ),
                expected,
            );

            const refusal = refusalFrom(() => compareAcrossDatabases({ ...thisRun, peer }));

            expect(refusal.code).toBe('compare_report_not_protocol_eligible');
            expect(refusal.detail).toEqual(['comparedReport.paginationCheck=fail']);
        });

        it('refuses when this run itself deviated from the committed protocol', () => {
            const peer = parsePeerReport(sourceOf(peerOf()), expected);

            const refusal = refusalFrom(() =>
                compareAcrossDatabases({
                    ...thisRun,
                    protocolDeviationCodes: ['timed_passes_overridden', 'stage_lock_not_held'],
                    peer,
                }),
            );

            expect(refusal.code).toBe('compare_report_not_protocol_eligible');
            expect(refusal.detail).toEqual([
                'thisRun.protocolDeviation=timed_passes_overridden',
                'thisRun.protocolDeviation=stage_lock_not_held',
            ]);
        });

        // This run's own instability is a measurement OUTCOME rather than an
        // input, and the run already fails closed on it with the artefact
        // written first. Throwing here would destroy that evidence, so the
        // comparison is recorded in full and concludes nothing.
        it('establishes nothing when this run’s ranks moved between its timed passes', () => {
            const comparison = compareAcrossDatabases({
                ...thisRun,
                unstableQueryIds: ['q001'],
                peer: parsePeerReport(sourceOf(peerOf()), expected),
            });

            expect(comparison.outcome).toBe('not_established');
            expect(comparison.fingerprintsMatch).toBe(true);
            expect(comparison.ranks).toMatchObject({ queriesCompared: 1, identical: 1, differingCount: 0 });
            expect(comparison.pageSequences).toMatchObject({ queriesCompared: 1, identical: 1 });
            expect(comparison.comparedWith).not.toBeNull();
            expect(comparison.statement).toContain('ESTABLISHES NOTHING');
            expect(comparison.statement).toContain('ordering is not total within one database');
            expect(comparison.statement).not.toContain('is a property of release');
        });

        it('establishes nothing when this run’s pagination check failed', () => {
            const comparison = compareAcrossDatabases({
                ...thisRun,
                paginationOutcome: 'fail',
                peer: parsePeerReport(sourceOf(peerOf()), expected),
            });

            expect(comparison.outcome).toBe('not_established');
            expect(comparison.ranks).toMatchObject({ queriesCompared: 1, identical: 1 });
            expect(comparison.statement).toContain('page sequences are not slices of a single order');
        });

        // A disagreement is a real finding about one of the two corpora even
        // when this run could not have established agreement, so it is still
        // reported as such.
        it('still reports a genuine difference from an unstable run', () => {
            const peer = parsePeerReport(
                sourceOf(
                    peerOf({
                        results: [
                            {
                                id: 'q001',
                                rank: 2,
                                rankInFullResultSet: 2,
                                matchSetTotal: 2,
                                matchedSourceKey: 'usda:1',
                            },
                        ],
                        determinismFingerprint: determinismFingerprint(
                            [result('q001', 2)],
                            [pagination('q001', ['usda:1'])],
                        ),
                    }),
                ),
                expected,
            );

            const comparison = compareAcrossDatabases({ ...thisRun, unstableQueryIds: ['q001'], peer });

            expect(comparison.outcome).toBe('differs');
            expect(comparison.ranks?.differingCount).toBe(1);
        });

        it('records the relationship it established beside the identity it compared', () => {
            const comparison = compareAcrossDatabases({
                ...thisRun,
                peer: parsePeerReport(sourceOf(peerOf()), expected),
            });

            expect(comparison.identityRelationship).toBe('distinct');
            expect(comparison.comparedWith?.systemIdentifier).toBe(PEER_IDENTITY.systemIdentifier);
            expect(comparison.statement).toContain('positively established as distinct');
        });
    });

    it('fails the run when the compared report differs, and writes the report first', async () => {
        const benchmark = makeBenchmark({ queries: [query('q001', 'coffee', ['usda:1'])] });
        const peerRaw = {
            ...peerOf({
                results: [
                    { id: 'q001', rank: 3, rankInFullResultSet: 3, matchSetTotal: 1, matchedSourceKey: 'usda:1' },
                ],
                paginationCheck: { outcome: 'pass', perQuery: [] },
                determinismFingerprint: 'c'.repeat(64),
            }),
        };
        const deps = makeDeps({
            benchmark,
            peerReport: {
                path: 'second-report.json',
                pathKind: 'name_only',
                sha256: 'd'.repeat(64),
                raw: peerRaw,
            },
        });

        const outcome: BenchmarkOutcome = await runBenchmark(deps);

        expect(outcome.report.crossDatabaseReproduction.outcome).toBe('differs');
        expect(outcome.report.crossDatabaseReproduction.identityRelationship).toBe('distinct');
        expect(outcome.invariantFailures.map((failure) => failure.code)).toEqual([
            'cross_database_reproduction_differs',
        ]);
        expect(outcome.report.verdict.overall).toBe('fail');
        expect(fs.existsSync(deps.outPath)).toBe(true);
    });

    // The tri-state exists because a boolean has to be negated to reach "two
    // databases", and `!same` reads an unreadable identity as proof of
    // distinctness — which would publish a report compared with ITSELF as the
    // second-database evidence on any server whose pg_control_system() is
    // restricted. Each unreadable component therefore gets its own case.
    describe('databaseRelationship', () => {
        it('is same for one readable identity against itself', () => {
            expect(databaseRelationship(THIS_IDENTITY, THIS_IDENTITY)).toBe('same');
        });

        it('is distinct for two complete, differing identities', () => {
            expect(databaseRelationship(THIS_IDENTITY, PEER_IDENTITY)).toBe('distinct');
        });

        it('is unverifiable whenever either side is missing either component', () => {
            const unreadable = { databaseOid: null, systemIdentifier: null };

            expect(databaseRelationship(unreadable, unreadable)).toBe('unverifiable');
            expect(
                databaseRelationship({ ...THIS_IDENTITY, databaseOid: null }, PEER_IDENTITY),
            ).toBe('unverifiable');
            expect(
                databaseRelationship({ ...THIS_IDENTITY, systemIdentifier: null }, PEER_IDENTITY),
            ).toBe('unverifiable');
            expect(
                databaseRelationship(THIS_IDENTITY, { ...PEER_IDENTITY, databaseOid: null }),
            ).toBe('unverifiable');
            expect(
                databaseRelationship(THIS_IDENTITY, { ...PEER_IDENTITY, systemIdentifier: null }),
            ).toBe('unverifiable');
        });
    });

    // A committed artefact naming /tmp/<something>/report.json opens nothing for
    // anyone who reads it later and states where the machine that produced it
    // kept its scratch files. The identity of a compared measurement is its
    // digest and its fingerprint, both of which the block records, so the path
    // is narrowed to something portable.
    describe('peerReportLabel', () => {
        const packageRoot = path.resolve(__dirname, '..', '..', '..');

        it('names a peer inside the package by its package-relative path', () => {
            expect(
                peerReportLabel(path.join(packageRoot, 'data', 'meal-planning', 'reports', 'latest', 'x.json'), packageRoot),
            ).toEqual({ label: 'data/meal-planning/reports/latest/x.json', pathKind: 'package_relative' });
        });

        it('names a peer outside the package by its file name alone', () => {
            expect(peerReportLabel('/var/tmp/run-1234/second-database.json', packageRoot)).toEqual({
                label: 'second-database.json',
                pathKind: 'name_only',
            });
        });

        it('treats a sibling of the package as outside it rather than as a ../ path', () => {
            expect(peerReportLabel(path.resolve(packageRoot, '..', 'elsewhere', 'report.json'), packageRoot)).toEqual({
                label: 'report.json',
                pathKind: 'name_only',
            });
        });
    });

    it('refuses a same-database comparison before it costs a measurement', async () => {
        const db = makeDb({ foods: THREE_FOODS });
        const deps = makeDeps({
            db,
            // The peer's identity is this run's own, which is what running
            // --compare-with against the report this database just produced
            // looks like.
            peerReport: {
                path: 'second-report.json',
                pathKind: 'name_only',
                sha256: 'd'.repeat(64),
                raw: peerOf({
                    conditions: {
                        postgresVersion: 'PostgreSQL 16.15',
                        databaseDefaultCollation: 'en_US.utf8',
                        databaseIdentity: {
                            databaseOid: Number(SCALARS['SELECT oid FROM pg_database WHERE datname = current_database()']),
                            systemIdentifier: SCALARS['SELECT system_identifier FROM pg_control_system()'],
                        },
                    },
                }),
            },
        });

        const refusal = await refusalOf(runBenchmark(deps));

        expect(refusal.code).toBe('compare_report_same_database');
        // The identity is read, but nothing is measured: no warm-up pass runs,
        // so no search call and no condition read follows it.
        expect(db.statements).toEqual([
            'SELECT oid FROM pg_database WHERE datname = current_database()',
            'SELECT system_identifier FROM pg_control_system()',
        ]);
        expect(fs.existsSync(deps.outPath)).toBe(false);
    });

    it('refuses to compare a run that deviated from the protocol, before measuring anything', async () => {
        // The deviation is known from the options alone, so the ineligibility
        // of the pair is settled at the same point as their identity rather
        // than after three timed passes.
        const db = makeDb({ foods: THREE_FOODS });
        const deps = makeDeps({
            db,
            timedPasses: 1,
            passesOverridden: true,
            peerReport: {
                path: 'second-report.json',
                pathKind: 'name_only',
                sha256: 'd'.repeat(64),
                raw: peerOf(),
            },
        });

        const refusal = await refusalOf(runBenchmark(deps));

        expect(refusal.code).toBe('compare_report_not_protocol_eligible');
        expect(refusal.detail).toEqual(['thisRun.protocolDeviation=timed_passes_overridden']);
        expect(db.statements).toEqual([
            'SELECT oid FROM pg_database WHERE datname = current_database()',
            'SELECT system_identifier FROM pg_control_system()',
        ]);
        expect(fs.existsSync(deps.outPath)).toBe(false);
    });

    it('refuses an unverifiable identity pair before it costs a measurement', async () => {
        // The run's own identity is unreadable while the peer's reads, which is
        // what --compare-with against a hardened server looks like. The early
        // check has to refuse it for the same reason the comparison does.
        const db = makeDb({
            foods: THREE_FOODS,
            unreadableStatements: [
                'SELECT oid FROM pg_database WHERE datname = current_database()',
                'SELECT system_identifier FROM pg_control_system()',
            ],
        });
        const deps = makeDeps({
            db,
            peerReport: {
                path: 'second-report.json',
                pathKind: 'name_only',
                sha256: 'd'.repeat(64),
                raw: peerOf(),
            },
        });

        const refusal = await refusalOf(runBenchmark(deps));

        expect(refusal.code).toBe('compare_report_identity_unverifiable');
        expect(refusal.detail).toEqual(['thisRun.systemIdentifier', 'thisRun.databaseOid']);
        expect(db.statements).toEqual([
            'SELECT oid FROM pg_database WHERE datname = current_database()',
            'SELECT system_identifier FROM pg_control_system()',
        ]);
        expect(fs.existsSync(deps.outPath)).toBe(false);
    });

    it('refuses an unreadable compared report before measuring anything', async () => {
        const deps = makeDeps({
            peerReport: {
                path: 'second-report.json',
                pathKind: 'name_only',
                sha256: 'd'.repeat(64),
                raw: { stage: 'search-benchmark' },
            },
            // Would refuse later if the peer were parsed after the binding.
            readActiveRelease: async () => POINTER,
        });

        const refusal = await refusalOf(runBenchmark(deps));

        expect(refusal.code).toBe('compare_report_unreadable');
        expect(deps.db.statements).toEqual([]);
        expect(fs.existsSync(deps.outPath)).toBe(false);
    });
});

// ---------------------------------------------------------------------------
// Conditions, and the report as a whole.
// ---------------------------------------------------------------------------

describe('the conditions a report records', () => {
    it('records the database identity without any host or name', async () => {
        const outcome = await runBenchmark(makeDeps());
        const identity = outcome.report.conditions.databaseIdentity;

        expect(identity.databaseOid).toBe(16451);
        expect(identity.systemIdentifier).toBe('7300000000000000001');
        expect(JSON.stringify(outcome.report)).not.toContain('soh_test');
        expect(JSON.stringify(outcome.report)).not.toContain('postgresql://');
    });

    it('records nulls rather than refusing when the identity cannot be read', async () => {
        const deps = makeDeps({
            db: makeDb({
                foods: THREE_FOODS,
                unreadableStatements: [
                    'SELECT system_identifier FROM pg_control_system()',
                    'SELECT oid FROM pg_database WHERE datname = current_database()',
                ],
            }),
        });

        const outcome = await runBenchmark(deps);

        expect(outcome.report.conditions.databaseIdentity).toMatchObject({
            databaseOid: null,
            systemIdentifier: null,
        });
        expect(outcome.report.conditions.databaseIdentity.statement).toContain('pg_control_system()');
    });

    it('still refuses a contract condition that cannot be read back', async () => {
        // A condition the contract's `reportedConditions` names is the opposite
        // case from the identity above: a blank one invalidates the evidence,
        // so it refuses with its own code rather than recording null.
        const { 'SHOW shared_buffers': _omitted, ...withoutSharedBuffers } = SCALARS;
        const deps = makeDeps({
            db: makeDb({ foods: THREE_FOODS, scalars: withoutSharedBuffers }),
        });

        const refusal = await refusalOf(runBenchmark(deps));

        expect(refusal.code).toBe('condition_unreadable');
        expect(refusal.detail).toEqual(['sharedBuffers']);
        expect(fs.existsSync(deps.outPath)).toBe(false);
    });

    it('records a fingerprint a second run of the same corpus reproduces', async () => {
        const first = await runBenchmark(makeDeps());
        const second = await runBenchmark(makeDeps());

        expect(first.report.determinismFingerprint).toMatch(/^[0-9a-f]{64}$/);
        expect(second.report.determinismFingerprint).toBe(first.report.determinismFingerprint);
    });
});

// ---------------------------------------------------------------------------
// The command line.
// ---------------------------------------------------------------------------

describe('parseArgs', () => {
    it('accepts --compare-with with a path', () => {
        const parsed = parseArgs(['--compare-with', 'reports/second.json']);

        expect(parsed.ok).toBe(true);
        expect(parsed.ok && parsed.options.compareWith).toBe('reports/second.json');
    });

    it('accepts --compare-with=<path>', () => {
        const parsed = parseArgs(['--compare-with=reports/second.json']);

        expect(parsed.ok && parsed.options.compareWith).toBe('reports/second.json');
    });

    it('rejects --compare-with with no value', () => {
        const parsed = parseArgs(['--compare-with']);

        expect(parsed.ok).toBe(false);
        expect(!parsed.ok && parsed.errors).toEqual([
            {
                flag: '--compare-with',
                message:
                    '--compare-with requires the path of a benchmark report from a second, independently ' +
                    'loaded database',
            },
        ]);
    });

    it('rejects --compare-with twice', () => {
        const parsed = parseArgs(['--compare-with', 'a.json', '--compare-with', 'b.json']);

        expect(parsed.ok).toBe(false);
        expect(!parsed.ok && parsed.errors[0].flag).toBe('--compare-with');
    });

    it('defaults the comparison to none', () => {
        const parsed = parseArgs([]);

        expect(parsed.ok && parsed.options.compareWith).toBeNull();
    });

    it('resolves the default artefact to the committed report path', () => {
        expect(resolveOutPath(null)).toBe(reportPath('benchmark-report.json'));
    });
});
