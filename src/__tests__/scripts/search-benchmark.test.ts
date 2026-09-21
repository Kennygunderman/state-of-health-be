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
 * `now`/`hrtime`/`readRepoFile`, an `outPath` under `os.tmpdir()` — and, where
 * the artefact guard itself is under test, an `acceptanceArtifactPath` there
 * too — plus the
 * pure decisions (`protocolDeviations`, `rateAtLeast`/`rateAtMost`,
 * `collectInvariantFailures`, `determinismFingerprint`, `parsePeerReport`,
 * `compareAcrossDatabases`, `pinPoolToSingleConnection`, `parseArgs`) called
 * directly. NO DATABASE IS NEEDED and none is touched: Rule
 * backend-architecture §11 asks for the rules to be provable without one, and
 * every rule here is a decision over values rather than a query.
 *
 * ONE BLOCK IS THE EXCEPTION, at the foot of the file, and it touches no
 * database either: the runner's own `--help` REACHABILITY. An exit status and
 * the module-load ordering ahead of `main()` cannot be observed from a process
 * that has already imported the module, so that block launches the real command
 * as a child against database URLs this stage's policy REFUSES — the two of
 * them naming databases no server answers — and reads its status and streams.
 *
 * Two files are read from the repository, both through the runner's own
 * loaders: `data/meal-planning/catalog/releases/v1/manifest.json`, because the
 * runner digests it as a measurement condition (the release version in every
 * fixture is therefore `v1`), and `data/meal-planning/search-benchmark.v1.json`,
 * because `assertSearchBenchmarkShape`'s bounds have to be pinned against the
 * document the plan actually cites — bounds that only ever see fixtures are
 * bounds nobody has checked the committed artefact against.
 * NOTHING under `data/` is written. The committed report path
 * is named as an OUTPUT in exactly one test, which asserts the run REFUSES
 * before writing, and that test is built so a regression makes it fail on a
 * different refusal rather than overwrite the artefact — see its own comment. It
 * is also the default `acceptanceArtifactPath` every other test inherits, which
 * is an input to the guard and never a write target; the tests that exercise
 * aliases of the artefact substitute a temporary stand-in for it, so a
 * regression in the guard destroys a file under `os.tmpdir()` rather than the
 * repository's acceptance evidence.
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
import { spawnSync } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { ManifestError, loadSearchBenchmark, reportPath } from '../../../scripts/lib/manifest';
import type {
    CatalogReleaseManifest,
    SearchBenchmark,
    SearchBenchmarkQuery,
} from '../../../scripts/lib/manifest';
import {
    BenchmarkInputError,
    assertSearchBenchmarkShape,
    collectInvariantFailures,
    compareAcrossDatabases,
    compareCorpusCounts,
    corpusMovement,
    databaseRelationship,
    describeFailure,
    determinismFingerprint,
    outputNameIsPublishable,
    outputPathIdentityChanges,
    parseArgs,
    parsePeerReport,
    peerReportDigest,
    peerReportLabel,
    pinPoolToSingleConnection,
    preflight,
    protocolDeviations,
    rateAtLeast,
    rateAtMost,
    readPeerReport,
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
    OutputPathObservation,
    PaginationQueryOutcome,
    PeerReportSource,
    PoolPinOutcome,
    QueryResult,
    SearchFn,
    SearchPage,
} from '../../../scripts/search-benchmark';
import { formatSafeError, opaqueDigest } from '../../../scripts/lib/logger';
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

/**
 * This package's root on disk — the prefix an absolute path would disclose, and
 * the thing the log-line assertions below look for the absence of. Resolved the
 * same way the script resolves it, from this file's own location, so it is
 * correct in any checkout.
 */
const PACKAGE_ROOT = path.resolve(__dirname, '..', '..', '..');

/** A temporary directory per test, removed by the suite's afterEach. */
const tempDirectories: string[] = [];

const tempDirectory = (): string => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'soh-benchmark-'));
    tempDirectories.push(directory);
    return directory;
};

const tempOutPath = (): string => path.join(tempDirectory(), 'benchmark-report.json');

/**
 * The bytes a stand-in acceptance artefact is seeded with. A test that claims
 * the committed report was left alone has to compare CONTENT: a run refused
 * before it writes and a run that overwrote the file both leave a file there.
 */
const COMMITTED_ARTEFACT_BYTES = '{"standIn":"the committed acceptance report"}\n';

/**
 * A temporary directory holding a file that stands in for the committed
 * acceptance artefact, plus the aliases a symlink attack would reach it
 * through. Returned rather than asserted on so each test picks the alias it is
 * about, and seeded with content so "untouched" is provable.
 *
 * The stand-in exists because the rule under test is "a diagnostic run may not
 * write the acceptance artefact", and the only way to prove a rule about
 * destroying a file is to let the destruction happen when the rule is absent.
 * Pointing these tests at the real
 * `data/meal-planning/reports/latest/benchmark-report.json` would make a
 * regression in the runner delete the repository's committed evidence instead
 * of failing a test — so `acceptanceArtifactPath` is injected and nothing under
 * `data/` is ever the target.
 */
interface AcceptanceArtefactAliases {
    /** The directory the artefact really lives in. */
    readonly directory: string;
    /** The artefact itself, canonically spelled. */
    readonly canonicalPath: string;
    /** A symlink to `directory`, so `<aliasDirectory>/<name>` is the artefact. */
    readonly aliasDirectory: string;
    /** `<aliasDirectory>/benchmark-report.json` — the symlinked-parent alias. */
    readonly throughAliasDirectory: string;
    /** A symlink AT a file name, pointing straight at `canonicalPath`. */
    readonly aliasFile: string;
}

const makeAcceptanceArtefactAliases = (): AcceptanceArtefactAliases => {
    const root = tempDirectory();
    const directory = path.join(root, 'reports-latest');
    fs.mkdirSync(directory);

    const canonicalPath = path.join(directory, 'benchmark-report.json');
    fs.writeFileSync(canonicalPath, COMMITTED_ARTEFACT_BYTES, 'utf8');

    const aliasDirectory = path.join(root, 'reports-alias');
    fs.symlinkSync(directory, aliasDirectory);

    const aliasFile = path.join(root, 'benchmark-report-alias.json');
    fs.symlinkSync(canonicalPath, aliasFile);

    return {
        directory,
        canonicalPath,
        aliasDirectory,
        throughAliasDirectory: path.join(aliasDirectory, 'benchmark-report.json'),
        aliasFile,
    };
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
        // The runner's own default, so a test that does not name the artefact
        // gets the same guard `main` installs; the alias tests pin it to a
        // temporary stand-in instead (see makeAcceptanceArtefactAliases).
        acceptanceArtifactPath: overrides.acceptanceArtifactPath ?? resolveOutPath(null),
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

    /**
     * NO LOG LINE NAMES AN ABSOLUTE PATH, which is the same disclosure the
     * peer-report refusal was carrying and reaches the same CI logs. The
     * artefact path is resolved absolutely because `writeJsonFile` needs it, so
     * the logged value is deliberately a different thing from the written one:
     * package-relative inside this package, the file name alone outside it.
     *
     * Driven twice, because the two branches leak differently. A temp-directory
     * path discloses `os.tmpdir()` and the random suffix; the default artefact
     * path discloses where this CHECKOUT lives, which for an agent clone is its
     * whole identity.
     */
    it('names the artefact in a log line without disclosing where the filesystem puts it', async () => {
        // The logger is held here rather than read back off `deps`, whose
        // `logger` is typed as the plain `ScriptLogger` the runner consumes.
        const logger = makeLogger();
        const deps = makeDeps({ logger, timedPasses: 1, passesOverridden: true });

        await runBenchmark(deps);

        const diagnostic = logger.events.find((entry) => entry.event === 'diagnostic_run');
        expect(diagnostic).toBeDefined();
        // Outside the package, so the file name alone.
        expect(diagnostic?.fields?.out).toBe('benchmark-report.json');

        // Asserted over EVERY field of EVERY line, not just the one field that
        // was fixed: a path added to a new line later is the regression this
        // case exists to catch.
        const serialised = JSON.stringify(logger.events);
        expect(serialised).not.toContain(os.tmpdir());
        expect(serialised).not.toContain(PACKAGE_ROOT);
    });

    it('names an in-package artefact package-relatively rather than absolutely', async () => {
        // The sibling case above covers a path OUTSIDE the package, which is
        // labelled by its file name alone. This one covers the other branch: a
        // path inside the package keeps its package-relative form, which is
        // both what the docs call the file and what an operator can act on,
        // without the checkout root in front of it.
        //
        // The release pointer is absent so the run refuses at
        // `bindRunToActiveRelease` — which happens AFTER `diagnostic_run` is
        // logged — so the line under test is produced and NO FILE IS WRITTEN
        // into the repository's report directory.
        const logger = makeLogger();
        const deps = makeDeps({
            logger,
            outPath: resolveOutPath('data/meal-planning/reports/latest/diagnostic-probe.json'),
            timedPasses: 1,
            passesOverridden: true,
            readActiveRelease: async () => null,
        });

        await refusalOf(runBenchmark(deps));

        const diagnostic = logger.events.find((entry) => entry.event === 'diagnostic_run');
        expect(diagnostic?.fields?.out).toBe('data/meal-planning/reports/latest/diagnostic-probe.json');
        expect(String(diagnostic?.fields?.out).startsWith('/')).toBe(false);
        expect(JSON.stringify(logger.events)).not.toContain(PACKAGE_ROOT);

        // The probe path was never written, because the run refused first.
        expect(fs.existsSync(resolveOutPath('data/meal-planning/reports/latest/diagnostic-probe.json'))).toBe(
            false,
        );
    });

    it('keeps the checkout path out of everything an operator sees when the default-path refusal fires', async () => {
        // The refusal that protects the acceptance artefact is the one place an
        // absolute path is still COMPOSED — its authored sentence names the
        // file it is protecting, because that sentence is what makes the remedy
        // intelligible. What matters is that nothing operator-visible carries
        // it: `describeFailure` reports the code and the closed error fields,
        // and the runner prints `error.detail`, so those are asserted here.
        // A future change that forwarded the message into a log field would
        // fail this case.
        const logger = makeLogger();
        const deps = makeDeps({
            logger,
            outPath: resolveOutPath(null),
            timedPasses: 1,
            passesOverridden: true,
        });

        const refusal = await refusalOf(runBenchmark(deps));
        expect(refusal.code).toBe('diagnostic_run_to_acceptance_path');

        const described = describeFailure(refusal);
        expect(JSON.stringify(described)).not.toContain(PACKAGE_ROOT);
        expect(described.error).not.toHaveProperty('message');
        // `detail` is what the runner prints as `input_detail.items`.
        expect(refusal.detail.join(' ')).not.toContain(PACKAGE_ROOT);
        expect(JSON.stringify(logger.events)).not.toContain(PACKAGE_ROOT);
    });

    it('lets a deviating run write an explicit path', async () => {
        const deps = makeDeps({ timedPasses: 1, passesOverridden: true });

        const outcome = await runBenchmark(deps);

        expect(fs.existsSync(deps.outPath)).toBe(true);
        expect(outcome.report.acceptanceEvidence.thisReportIsAcceptanceEvidence).toBe(false);
    });

    /**
     * THE ARTEFACT GUARD IS ABOUT A FILE, NOT ABOUT A SPELLING.
     *
     * A guard that compared `--out` with the canonical path as strings was
     * satisfied by every alias of the artefact — a symlinked parent directory,
     * a symlink at the file name — and the diagnostic report then landed on the
     * committed §0.9.3 acceptance evidence, destroying it and leaving something
     * that looks like it in its place (CWE-59). Each refusal case below
     * therefore asserts BOTH that the run refused AND that the artefact's bytes
     * are the ones it was seeded with: a refusal that came too late would leave
     * the same file present but rewritten. The cases that DO write assert where
     * the bytes went, because a guard that refused an alias while still writing
     * through one would pass the first kind of case and fail nothing.
     *
     * Every path here is under `fs.mkdtempSync`, and the artefact the guard
     * protects is injected (`acceptanceArtifactPath`). That is what makes these
     * tests safe to write: if the refusal regresses, the run overwrites a
     * temporary stand-in and the assertion fails, instead of overwriting the
     * repository's committed report.
     */
    describe('the physical identity of the output path', () => {
        const artefactBytes = (aliases: AcceptanceArtefactAliases): string =>
            fs.readFileSync(aliases.canonicalPath, 'utf8');

        it('refuses a deviating run reaching the artefact through a symlinked parent directory', async () => {
            const aliases = makeAcceptanceArtefactAliases();

            // Settled rather than asserted-on immediately, so the artefact's
            // bytes are checked whichever way the run ended: a run that wrote
            // the artefact and a run that refused both leave a file there, and
            // the content is the only thing that tells them apart.
            const settled = await runBenchmark(
                makeDeps({
                    outPath: aliases.throughAliasDirectory,
                    acceptanceArtifactPath: aliases.canonicalPath,
                    timedPasses: 1,
                    passesOverridden: true,
                }),
            ).then(
                () => null,
                (error: unknown) => error,
            );

            expect(artefactBytes(aliases)).toBe(COMMITTED_ARTEFACT_BYTES);

            expect(settled).toBeInstanceOf(BenchmarkInputError);
            const refusal = settled as BenchmarkInputError;
            expect(refusal.code).toBe('diagnostic_run_to_acceptance_path');
            expect(refusal.detail).toEqual(['timed_passes_overridden']);
            expect(refusal.message).toContain('--out');
            // The alias is named back to the operator with what it resolves to,
            // because "that path is the acceptance artefact" is not obvious from
            // the spelling they typed.
            expect(refusal.message).toContain(aliases.throughAliasDirectory);
            expect(refusal.message).toContain(aliases.canonicalPath);
        });

        it('refuses a deviating run reaching the artefact through a symlink at its file name', async () => {
            const aliases = makeAcceptanceArtefactAliases();

            const refusal = await refusalOf(
                runBenchmark(
                    makeDeps({
                        outPath: aliases.aliasFile,
                        acceptanceArtifactPath: aliases.canonicalPath,
                        stageLockHeld: false,
                    }),
                ),
            );

            expect(refusal.code).toBe('diagnostic_run_to_acceptance_path');
            expect(refusal.detail).toEqual(['stage_lock_not_held']);

            expect(artefactBytes(aliases)).toBe(COMMITTED_ARTEFACT_BYTES);
        });

        // No symlink at all in this one: a `..` detour is enough to defeat a
        // string comparison, and `path.join` would have normalised it away, so
        // the spelling is assembled by hand to be the one an operator (or an
        // attacker) could actually pass on the command line.
        it('refuses a deviating run whose --out spells the artefact with a ".." detour', async () => {
            const aliases = makeAcceptanceArtefactAliases();
            const detour = [
                aliases.directory,
                '..',
                path.basename(aliases.directory),
                'benchmark-report.json',
            ].join(path.sep);
            expect(detour).not.toBe(aliases.canonicalPath);

            const refusal = await refusalOf(
                runBenchmark(
                    makeDeps({
                        outPath: detour,
                        acceptanceArtifactPath: aliases.canonicalPath,
                        timedPasses: 1,
                        passesOverridden: true,
                    }),
                ),
            );

            expect(refusal.code).toBe('diagnostic_run_to_acceptance_path');
            expect(artefactBytes(aliases)).toBe(COMMITTED_ARTEFACT_BYTES);
        });

        // The guard refuses an alias of the ARTEFACT, and nothing else: a
        // diagnostic run to any other file is the documented remedy the refusal
        // itself recommends, so it has to keep working — including when the
        // operator reaches that file through a link of their own.
        it('lets a deviating run write a different file reached through a symlinked parent', async () => {
            const aliases = makeAcceptanceArtefactAliases();
            const diagnosticDirectory = path.join(tempDirectory(), 'diagnostics');
            fs.mkdirSync(diagnosticDirectory);
            const diagnosticAlias = path.join(path.dirname(diagnosticDirectory), 'diagnostics-alias');
            fs.symlinkSync(diagnosticDirectory, diagnosticAlias);

            const outcome = await runBenchmark(
                makeDeps({
                    outPath: path.join(diagnosticAlias, 'benchmark-report.json'),
                    acceptanceArtifactPath: aliases.canonicalPath,
                    timedPasses: 1,
                    passesOverridden: true,
                }),
            );

            // Written where the alias physically points, and reported as that
            // path rather than as the spelling that was asked for.
            expect(outcome.outPath).toBe(path.join(diagnosticDirectory, 'benchmark-report.json'));
            expect(fs.existsSync(outcome.outPath)).toBe(true);
            expect(outcome.report.acceptanceEvidence.thisReportIsAcceptanceEvidence).toBe(false);
            expect(artefactBytes(aliases)).toBe(COMMITTED_ARTEFACT_BYTES);
        });

        it('lets an undeviating run write the artefact itself', async () => {
            const aliases = makeAcceptanceArtefactAliases();

            const outcome = await runBenchmark(
                makeDeps({
                    outPath: aliases.canonicalPath,
                    acceptanceArtifactPath: aliases.canonicalPath,
                }),
            );

            expect(outcome.outPath).toBe(aliases.canonicalPath);
            expect(outcome.report.verdict.standing).toBe('acceptance_evidence');
            // The acceptance run is the one run that MAY replace it. Compared
            // against the report's own JSON form, which is what was written.
            expect(artefactBytes(aliases)).not.toBe(COMMITTED_ARTEFACT_BYTES);
            expect(JSON.parse(artefactBytes(aliases))).toEqual(JSON.parse(JSON.stringify(outcome.report)));
        });

        it('lets an undeviating run write the artefact through an alias of it', async () => {
            const aliases = makeAcceptanceArtefactAliases();

            const outcome = await runBenchmark(
                makeDeps({
                    outPath: aliases.throughAliasDirectory,
                    acceptanceArtifactPath: aliases.canonicalPath,
                }),
            );

            expect(outcome.outPath).toBe(aliases.canonicalPath);
            expect(JSON.parse(artefactBytes(aliases))).toEqual(JSON.parse(JSON.stringify(outcome.report)));
        });

        /**
         * The raced alias. Checking a path and then writing the spelling that
         * was checked is two lookups of one name, and a local principal who can
         * retarget the link between them chooses where the bytes land — the
         * minutes this stage spends measuring are exactly that window. The run
         * resolves the path once, before the guard, and writes THAT, so the
         * retarget below has nothing left to redirect.
         */
        it('writes where the path resolved before the run, not where a link was retargeted during it', async () => {
            const aliases = makeAcceptanceArtefactAliases();
            const root = tempDirectory();
            const resolvedDirectory = path.join(root, 'resolved-at-the-start');
            const retargetedDirectory = path.join(root, 'retargeted-mid-run');
            fs.mkdirSync(resolvedDirectory);
            fs.mkdirSync(retargetedDirectory);
            const movingAlias = path.join(root, 'moving-alias');
            fs.symlinkSync(resolvedDirectory, movingAlias);

            const benchmark = makeBenchmark();
            const scoring = expectedFirst(benchmark, THREE_FOODS);
            let retargeted = false;
            const retargetOnFirstQuery = async (q: string): Promise<SearchPage> => {
                if (!retargeted) {
                    retargeted = true;
                    fs.unlinkSync(movingAlias);
                    fs.symlinkSync(retargetedDirectory, movingAlias);
                }
                return scoring(q);
            };

            const outcome = await runBenchmark(
                makeDeps({
                    benchmark,
                    search: retargetOnFirstQuery,
                    outPath: path.join(movingAlias, 'benchmark-report.json'),
                    acceptanceArtifactPath: aliases.canonicalPath,
                    timedPasses: 1,
                    passesOverridden: true,
                }),
            );

            expect(retargeted).toBe(true);
            // Where the bytes are is asserted before what the outcome says
            // about them: a redirected write is the failure this test exists
            // for, and it should be what the failure message shows.
            expect(fs.existsSync(path.join(resolvedDirectory, 'benchmark-report.json'))).toBe(true);
            expect(fs.existsSync(path.join(retargetedDirectory, 'benchmark-report.json'))).toBe(false);
            expect(outcome.outPath).toBe(path.join(resolvedDirectory, 'benchmark-report.json'));
        });

        /**
         * THE WINDOW AFTER THE GUARD.
         *
         * Resolving the output path once defeats every alias the operator's
         * spelling could carry, and the test above proves it. It does not
         * defeat the directory that path names being REPLACED while the run
         * measures: a resolved path is a name inside a directory, and a
         * principal who can write that directory's parent can rename it aside
         * mid-run and put a symbolic link to
         * data/meal-planning/reports/latest in its place. Every check had
         * already passed by then, and the diagnostic report would land on the
         * §0.9.3 acceptance evidence (CWE-59/CWE-367).
         *
         * Each case below performs that replacement from inside the seam the
         * run awaits — the first search call, i.e. the warm-up pass — which is
         * the real window, and then asserts on the BYTES of the stand-in
         * acceptance artefact before anything else: a run that published into
         * the swapped directory and a run that refused both end with a file at
         * that path, and only the content tells them apart. The stand-in is the
         * injected `acceptanceArtifactPath`, never the committed report, so a
         * regression fails these assertions instead of destroying the
         * repository's evidence.
         */
        describe('the window between the guard and the publication write', () => {
            /**
             * Renames the resolved output directory aside on the run's first
             * query and lets `replace` decide what, if anything, takes its
             * place at that path.
             */
            const swapDirectoryOnFirstQuery = (
                benchmark: SearchBenchmark,
                resolvedDirectory: string,
                replace: () => void,
            ): { readonly search: SearchFn; readonly swapped: () => boolean } => {
                const scoring = expectedFirst(benchmark, THREE_FOODS);
                let swapped = false;
                return {
                    swapped: () => swapped,
                    search: async (q: string): Promise<SearchPage> => {
                        if (!swapped) {
                            swapped = true;
                            fs.renameSync(resolvedDirectory, `${resolvedDirectory}-moved-aside`);
                            replace();
                        }
                        return scoring(q);
                    },
                };
            };

            const outputDirectory = (): string => {
                const directory = path.join(tempDirectory(), 'diagnostics');
                fs.mkdirSync(directory, { mode: 0o700 });
                return directory;
            };

            it('refuses when the output directory becomes a link to the acceptance directory mid-run', async () => {
                const aliases = makeAcceptanceArtefactAliases();
                const directory = outputDirectory();
                const benchmark = makeBenchmark();
                const attack = swapDirectoryOnFirstQuery(benchmark, directory, () => {
                    fs.symlinkSync(aliases.directory, directory);
                });

                const settled = await runBenchmark(
                    makeDeps({
                        benchmark,
                        search: attack.search,
                        outPath: path.join(directory, 'benchmark-report.json'),
                        acceptanceArtifactPath: aliases.canonicalPath,
                        timedPasses: 1,
                        passesOverridden: true,
                    }),
                ).then(
                    () => null,
                    (error: unknown) => error,
                );

                expect(attack.swapped()).toBe(true);
                expect(artefactBytes(aliases)).toBe(COMMITTED_ARTEFACT_BYTES);
                // No staging debris either: a partially published document in
                // the acceptance directory is a redirected write that merely
                // failed to finish.
                expect(fs.readdirSync(aliases.directory)).toEqual(['benchmark-report.json']);

                expect(settled).toBeInstanceOf(BenchmarkInputError);
                const refusal = settled as BenchmarkInputError;
                // The acceptance-path code, not the identity one: the run's
                // output path now resolves ONTO the artefact, which is the
                // refusal the pre-run guard would have given, and an operator
                // needs the same diagnosis whichever side of the measurement it
                // is discovered on.
                expect(refusal.code).toBe('diagnostic_run_to_acceptance_path');
                expect(refusal.detail).toEqual(['timed_passes_overridden']);
                expect(refusal.message).toContain(aliases.canonicalPath);
            });

            it('refuses when the output directory becomes a link to an unrelated directory mid-run', async () => {
                const aliases = makeAcceptanceArtefactAliases();
                const directory = outputDirectory();
                const elsewhere = path.join(tempDirectory(), 'elsewhere');
                fs.mkdirSync(elsewhere, { mode: 0o700 });
                const benchmark = makeBenchmark();
                const attack = swapDirectoryOnFirstQuery(benchmark, directory, () => {
                    fs.symlinkSync(elsewhere, directory);
                });

                // Undeviating on purpose: the identity check is not a
                // consequence of being diagnostic. An acceptance run redirected
                // into another directory is just as much a redirected write.
                const settled = await runBenchmark(
                    makeDeps({
                        benchmark,
                        search: attack.search,
                        outPath: path.join(directory, 'benchmark-report.json'),
                        acceptanceArtifactPath: aliases.canonicalPath,
                    }),
                ).then(
                    () => null,
                    (error: unknown) => error,
                );

                expect(attack.swapped()).toBe(true);
                expect(fs.readdirSync(elsewhere)).toEqual([]);
                expect(fs.readdirSync(`${directory}-moved-aside`)).toEqual([]);
                expect(artefactBytes(aliases)).toBe(COMMITTED_ARTEFACT_BYTES);

                expect(settled).toBeInstanceOf(BenchmarkInputError);
                const refusal = settled as BenchmarkInputError;
                expect(refusal.code).toBe('output_path_identity_changed');
                expect(refusal.detail).toContain('parent_no_longer_a_directory');
                expect(refusal.detail.some((entry) => entry.startsWith('parent_inode_changed='))).toBe(true);
                expect(refusal.message).toContain('NOT written');
            });

            // A real directory at the same path, so nothing about it is a
            // symbolic link and only the captured inode can tell it is not the
            // directory that was verified.
            it('refuses when the output directory is replaced by a different real directory mid-run', async () => {
                const aliases = makeAcceptanceArtefactAliases();
                const directory = outputDirectory();
                const benchmark = makeBenchmark();
                const attack = swapDirectoryOnFirstQuery(benchmark, directory, () => {
                    fs.mkdirSync(directory, { mode: 0o700 });
                });

                const settled = await runBenchmark(
                    makeDeps({
                        benchmark,
                        search: attack.search,
                        outPath: path.join(directory, 'benchmark-report.json'),
                        acceptanceArtifactPath: aliases.canonicalPath,
                    }),
                ).then(
                    () => null,
                    (error: unknown) => error,
                );

                expect(attack.swapped()).toBe(true);
                expect(fs.readdirSync(directory)).toEqual([]);
                expect(artefactBytes(aliases)).toBe(COMMITTED_ARTEFACT_BYTES);

                expect(settled).toBeInstanceOf(BenchmarkInputError);
                const refusal = settled as BenchmarkInputError;
                expect(refusal.code).toBe('output_path_identity_changed');
                expect(refusal.detail.some((entry) => entry.startsWith('parent_inode_changed='))).toBe(true);
                expect(refusal.detail).not.toContain('parent_no_longer_a_directory');
            });

            it('refuses when the output directory is renamed away mid-run and nothing replaces it', async () => {
                const aliases = makeAcceptanceArtefactAliases();
                const directory = outputDirectory();
                const benchmark = makeBenchmark();
                const attack = swapDirectoryOnFirstQuery(benchmark, directory, () => undefined);

                const settled = await runBenchmark(
                    makeDeps({
                        benchmark,
                        search: attack.search,
                        outPath: path.join(directory, 'benchmark-report.json'),
                        acceptanceArtifactPath: aliases.canonicalPath,
                    }),
                ).then(
                    () => null,
                    (error: unknown) => error,
                );

                expect(attack.swapped()).toBe(true);
                expect(fs.existsSync(directory)).toBe(false);
                expect(artefactBytes(aliases)).toBe(COMMITTED_ARTEFACT_BYTES);

                expect(settled).toBeInstanceOf(BenchmarkInputError);
                const refusal = settled as BenchmarkInputError;
                expect(refusal.code).toBe('output_path_identity_changed');
                expect(refusal.detail).toEqual(['output_parent_unreadable']);
            });

            // The measurement is not the only thing the window covers: a run
            // that measured fine and published into a directory it could no
            // longer identify would still be a redirected write, so the
            // positive control belongs beside the refusals.
            it('publishes normally when the output directory stays the one it verified', async () => {
                const aliases = makeAcceptanceArtefactAliases();
                const directory = outputDirectory();
                const outPath = path.join(directory, 'benchmark-report.json');

                const outcome = await runBenchmark(
                    makeDeps({ outPath, acceptanceArtifactPath: aliases.canonicalPath }),
                );

                expect(outcome.outPath).toBe(outPath);
                expect(JSON.parse(fs.readFileSync(outPath, 'utf8'))).toEqual(
                    JSON.parse(JSON.stringify(outcome.report)),
                );
                expect(artefactBytes(aliases)).toBe(COMMITTED_ARTEFACT_BYTES);
            });
        });

        /**
         * The artefact's own NAME, `lstat`ed rather than followed.
         *
         * `physicalPathIdentity` resolves the final component, so a symbolic
         * link there is answered with "which file it points at" instead of
         * being refused — and the file it points at is chosen by whoever owns
         * the link, which for an output artefact is the whole of the attack.
         * Refusing the name outright is what makes the resolved path the
         * operator's own file.
         */
        describe('a symbolic link at the artefact name', () => {
            it('refuses an --out that is a link to another file', async () => {
                const aliases = makeAcceptanceArtefactAliases();
                const root = tempDirectory();
                const target = path.join(root, 'someone-elses-report.json');
                fs.writeFileSync(target, COMMITTED_ARTEFACT_BYTES, 'utf8');
                const link = path.join(root, 'benchmark-report.json');
                fs.symlinkSync(target, link);

                const refusal = await refusalOf(
                    runBenchmark(makeDeps({ outPath: link, acceptanceArtifactPath: aliases.canonicalPath })),
                );

                expect(refusal.code).toBe('output_path_name_unsafe');
                expect(refusal.detail).toEqual(['spelled=symbolic_link', 'resolved=file']);
                expect(fs.readFileSync(target, 'utf8')).toBe(COMMITTED_ARTEFACT_BYTES);
            });

            it('refuses an --out that is a dangling link', async () => {
                const aliases = makeAcceptanceArtefactAliases();
                const root = tempDirectory();
                const link = path.join(root, 'benchmark-report.json');
                fs.symlinkSync(path.join(root, 'not-created-yet.json'), link);

                const refusal = await refusalOf(
                    runBenchmark(makeDeps({ outPath: link, acceptanceArtifactPath: aliases.canonicalPath })),
                );

                expect(refusal.code).toBe('output_path_name_unsafe');
                expect(refusal.detail).toContain('spelled=symbolic_link');
                expect(fs.existsSync(path.join(root, 'not-created-yet.json'))).toBe(false);
            });

            it('refuses an --out that names a directory', async () => {
                const aliases = makeAcceptanceArtefactAliases();
                const directory = path.join(tempDirectory(), 'benchmark-report.json');
                fs.mkdirSync(directory, { mode: 0o700 });

                const refusal = await refusalOf(
                    runBenchmark(makeDeps({ outPath: directory, acceptanceArtifactPath: aliases.canonicalPath })),
                );

                expect(refusal.code).toBe('output_path_name_unsafe');
                expect(refusal.detail).toEqual(['spelled=other', 'resolved=other']);
                expect(fs.readdirSync(directory)).toEqual([]);
            });
        });

        /**
         * The parent is held to the shared primitive rather than to a rule of
         * this runner's own: a directory other local principals can plant a
         * name in is one where the artefact's name can be pre-placed as a link
         * before this run creates it, and `assertSafeArtifactParent` in
         * `scripts/lib/manifest.ts` is where that rule lives for every
         * publishing stage. This test pins that the benchmark actually calls
         * it — and that it does so BEFORE the measurement, not after.
         */
        describe('the output directory other principals can write to', () => {
            it('refuses a world-writable non-sticky output directory before measuring', async () => {
                const aliases = makeAcceptanceArtefactAliases();
                const directory = path.join(tempDirectory(), 'shared');
                fs.mkdirSync(directory, { mode: 0o700 });
                fs.chmodSync(directory, 0o777);
                const benchmark = makeBenchmark();
                let queries = 0;
                const scoring = expectedFirst(benchmark, THREE_FOODS);

                const settled = await runBenchmark(
                    makeDeps({
                        benchmark,
                        search: async (q: string): Promise<SearchPage> => {
                            queries += 1;
                            return scoring(q);
                        },
                        outPath: path.join(directory, 'benchmark-report.json'),
                        acceptanceArtifactPath: aliases.canonicalPath,
                    }),
                ).then(
                    () => null,
                    (error: unknown) => error,
                );

                expect(settled).toBeInstanceOf(ManifestError);
                expect((settled as ManifestError).code).toBe('unsafe_artifact_directory');
                expect(queries).toBe(0);
                expect(fs.readdirSync(directory)).toEqual([]);
            });

            it('creates a missing output directory owner-only and publishes into it', async () => {
                const aliases = makeAcceptanceArtefactAliases();
                const nested = path.join(tempDirectory(), 'nested', 'reports');

                const outcome = await runBenchmark(
                    makeDeps({
                        outPath: path.join(nested, 'benchmark-report.json'),
                        acceptanceArtifactPath: aliases.canonicalPath,
                    }),
                );

                expect(fs.existsSync(outcome.outPath)).toBe(true);
                // Owner-only, so the directory this stage made for its own
                // artefact is not one another principal can plant a name in on
                // the next run.
                expect(fs.statSync(nested).mode & 0o777).toBe(0o700);
            });
        });
    });

    /**
     * The post-guard decision as a decision over VALUES: two observations in,
     * every difference between them out. Driven directly, with no filesystem at
     * all, because that is what makes each difference enumerable — the run
     * itself can only produce one of them per test, and a later edit dropping
     * one of the fields from the comparison would silently reopen the window.
     */
    describe('outputPathIdentityChanges', () => {
        const observed: OutputPathObservation = {
            parentDevice: 2049,
            parentInode: 424242,
            parentIsDirectory: true,
            nameKind: 'absent',
        };

        it('reports nothing when the target is still the place that was verified', () => {
            expect(outputPathIdentityChanges(observed, { ...observed })).toEqual([]);
        });

        it('accepts the artefact name having appeared as a plain file', () => {
            expect(outputPathIdentityChanges(observed, { ...observed, nameKind: 'file' })).toEqual([]);
        });

        it('names a parent on a different device, with both values', () => {
            expect(outputPathIdentityChanges(observed, { ...observed, parentDevice: 2050 })).toEqual([
                'parent_device_changed=2049->2050',
            ]);
        });

        it('names a replaced parent inode, with both values', () => {
            expect(outputPathIdentityChanges(observed, { ...observed, parentInode: 99 })).toEqual([
                'parent_inode_changed=424242->99',
            ]);
        });

        it('names a parent that is no longer a directory', () => {
            expect(outputPathIdentityChanges(observed, { ...observed, parentIsDirectory: false })).toEqual([
                'parent_no_longer_a_directory',
            ]);
        });

        it('names a link that appeared at the artefact name', () => {
            expect(outputPathIdentityChanges(observed, { ...observed, nameKind: 'symbolic_link' })).toEqual([
                'output_name_not_publishable=symbolic_link',
            ]);
        });

        it('treats an unreadable parent as a change rather than as no observation', () => {
            expect(outputPathIdentityChanges(observed, null)).toEqual(['output_parent_unreadable']);
        });

        it('names every difference of a parent swapped for a link to somewhere else', () => {
            expect(
                outputPathIdentityChanges(observed, {
                    parentDevice: 2050,
                    parentInode: 7,
                    parentIsDirectory: false,
                    nameKind: 'unreadable',
                }),
            ).toEqual([
                'parent_device_changed=2049->2050',
                'parent_inode_changed=424242->7',
                'parent_no_longer_a_directory',
                'output_name_not_publishable=unreadable',
            ]);
        });
    });

    describe('outputNameIsPublishable', () => {
        it('publishes to a name that does not exist yet and to a plain file', () => {
            expect(outputNameIsPublishable('absent')).toBe(true);
            expect(outputNameIsPublishable('file')).toBe(true);
        });

        it('refuses a link, a directory and a name whose kind could not be read', () => {
            expect(outputNameIsPublishable('symbolic_link')).toBe(false);
            expect(outputNameIsPublishable('other')).toBe(false);
            expect(outputNameIsPublishable('unreadable')).toBe(false);
        });
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

    /**
     * `--compare-with` names a file the operator chose, normally outside this
     * repository, and the two ways it can fail to be a report are the two
     * places a path and a foreign message used to reach the durable log: the
     * refusal quoted the absolute path it tried to open and the message `fs` or
     * `JSON.parse` produced, which carries the path again and, for the parser, a
     * fragment of the document (CWE-532/CWE-209).
     *
     * Every assertion below is made against the SERIALISED failure lines rather
     * than against a single field, because a substring is how a path leaks: it
     * only has to survive in one member of one line to be published to a
     * terminal, to CI retention and to the run log a committed report is
     * assembled from.
     */
    describe('readPeerReport', () => {
        const STAGE = 'search-benchmark';

        /** A peer file under os.tmpdir(), removed by the suite's afterEach. */
        const peerFile = (fileName: string, contents: string | null): string => {
            const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'soh-peer-layout-'));
            tempDirectories.push(directory);
            const absolutePath = path.join(directory, fileName);
            if (contents !== null) {
                fs.writeFileSync(absolutePath, contents, 'utf8');
            }
            return absolutePath;
        };

        /**
         * Both lines `main`'s top-level catch writes for a `BenchmarkInputError`,
         * serialised as the logger serialises them. Built from `describeFailure`
         * and `error.detail` themselves so this is the runner's own output and
         * not a transcription of it.
         */
        const failureLinesOf = (error: BenchmarkInputError): string => {
            const failure = describeFailure(error);
            return JSON.stringify([
                { event: 'stage_failed', stage: STAGE, code: failure.code, error: failure.error, ...failure.detail },
                {
                    event: 'input_detail',
                    stage: STAGE,
                    code: error.code,
                    items: error.detail.slice(0, 25),
                    itemCount: error.detail.length,
                },
            ]);
        };

        /**
         * The value the platform threw, so a test can assert both halves of the
         * rule against the same failure: that its MESSAGE does not appear, and
         * that what does appear is exactly `formatSafeError`'s rendering of it.
         *
         * The rendering is taken from the helper rather than written out as a
         * literal because it is realm-dependent under Jest and only under Jest:
         * `fs` and `JSON` construct their errors in the parent realm, so
         * `safeError`'s `instanceof Error` is false inside the sandbox and the
         * clause reads `UnknownError`, while the same refusal from
         * `npm run search:benchmark` — one realm — reads
         * `Error (code ENOENT)`. Both are safe; asserting the helper's own
         * answer is what makes this test pin the rule rather than the runtime.
         */
        const thrownBy = (call: () => unknown): unknown => {
            try {
                call();
            } catch (error) {
                return error;
            }
            throw new Error('expected the call to throw, but it returned');
        };

        const messageOf = (error: unknown): string =>
            error instanceof Error ? error.message : String((error as { message?: unknown })?.message);

        it('refuses a file it cannot open with the failing class and without the path', () => {
            const absolutePath = peerFile('second-database-report.json', null);
            const openFailure = thrownBy(() => fs.readFileSync(absolutePath));

            const refusal = refusalFrom(() => readPeerReport(absolutePath));
            const lines = failureLinesOf(refusal);

            expect(refusal.code).toBe('compare_report_unreadable');
            // The actionable half survives: the class and, in a single-realm
            // runtime, its machine code.
            expect(lines).toContain(`cause=${formatSafeError(openFailure)}`);
            expect(lines).toContain(`peerReportDigest=${opaqueDigest(absolutePath)}`);
            expect(lines).toContain('Produce the peer report by running this command against the second database');
            // The disclosure does not: not the path, not any segment of it, and
            // not the platform's own prose.
            expect(lines).not.toContain(absolutePath);
            expect(lines).not.toContain(path.dirname(absolutePath));
            expect(lines).not.toContain(path.basename(path.dirname(absolutePath)));
            expect(lines).not.toContain('second-database-report.json');
            expect(lines).not.toContain(os.tmpdir());
            expect(lines).not.toContain(messageOf(openFailure));
            expect(lines).not.toContain('no such file or directory');
        });

        it('refuses a file that is not JSON without quoting the document or the parser', () => {
            // The marker stands in for document content: a JSON SyntaxError
            // quotes the bytes it choked on, so a forwarded parser message
            // republishes a fragment of a file this stage did not author.
            const contents = '{"peerMarkerThatMustNotBeLogged": ';
            const absolutePath = peerFile('second-database-report.json', contents);
            const parseFailure = thrownBy(() => JSON.parse(contents));

            const refusal = refusalFrom(() => readPeerReport(absolutePath));
            const lines = failureLinesOf(refusal);

            expect(refusal.code).toBe('compare_report_unreadable');
            expect(lines).toContain(`cause=${formatSafeError(parseFailure)}`);
            expect(lines).toContain(`peerReportDigest=${opaqueDigest(absolutePath)}`);
            expect(lines).not.toContain(absolutePath);
            expect(lines).not.toContain(path.basename(path.dirname(absolutePath)));
            expect(lines).not.toContain('peerMarkerThatMustNotBeLogged');
            expect(lines).not.toContain(messageOf(parseFailure));
        });

        it('reads a well-formed peer report and narrows its path to the file name', () => {
            const absolutePath = peerFile('second-database-report.json', '{"stage":"search-benchmark"}');

            const source = readPeerReport(absolutePath);

            expect(source).toEqual({
                path: 'second-database-report.json',
                pathKind: 'name_only',
                sha256: crypto.createHash('sha256').update('{"stage":"search-benchmark"}').digest('hex'),
                raw: { stage: 'search-benchmark' },
            });
            expect(JSON.stringify(source)).not.toContain(path.dirname(absolutePath));
        });

        it('digests the resolved path, so two spellings of one file correlate', () => {
            const absolutePath = peerFile('second-database-report.json', '{}');
            const packageRelative = path.relative(path.resolve(__dirname, '..', '..', '..'), absolutePath);

            expect(peerReportDigest(absolutePath)).toBe(opaqueDigest(absolutePath));
            expect(peerReportDigest(packageRelative)).toBe(peerReportDigest(absolutePath));
            // Twelve hex characters and nothing that could be read as a path.
            expect(peerReportDigest(absolutePath)).toMatch(/^[0-9a-f]{12}$/);
        });

        it('states the absence rather than a digest when no comparison was requested', () => {
            expect(peerReportDigest(null)).toBe('none');
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

// ---------------------------------------------------------------------------
// The committed query set's shape.
//
// `loadSearchBenchmark` checks the document's version and declares the rest, so
// every field below reaches a SQL `LIMIT`, a bound parameter, a loop bound, a
// Map key or the committed report as whatever the file actually holds. These
// tests pin the two halves of the gate: the committed artefact passes it
// unchanged, and each field the runner consumes is refused — with no part of
// the offending value in the refusal — before anything is measured.
// ---------------------------------------------------------------------------

describe('assertSearchBenchmarkShape', () => {
    /** A mutable deep copy of a document that passes, to break one field of. */
    const validDocument = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
        ...(JSON.parse(JSON.stringify(makeBenchmark())) as Record<string, unknown>),
        ...overrides,
    });

    /** The same, with one query replaced by a broken one. */
    const withBrokenQuery = (overrides: Record<string, unknown>): Record<string, unknown> =>
        validDocument({
            queries: [
                { ...query('q001', 'coffee', ['usda:1']) },
                { ...query('q002', 'tea', ['usda:2']), ...overrides },
            ],
        });

    const shapeRefusalFor = (document: unknown): BenchmarkInputError =>
        refusalFrom(() => assertSearchBenchmarkShape(document));

    it('accepts the committed query set exactly as committed', () => {
        const committed = loadSearchBenchmark();

        // Returned as parsed rather than rebuilt, so the curation notes beside
        // the payload — `description`, `kinds`, `omittedFoods`, the per-field
        // rationales — reach the report's own copy instead of being dropped by
        // the check.
        expect(assertSearchBenchmarkShape(committed)).toBe(committed);
        const asRecord = committed as unknown as Record<string, unknown>;
        expect(asRecord.kinds).toBeDefined();
        expect(asRecord.omittedFoods).toBeDefined();
        expect(asRecord.thresholdPolicy).toBeDefined();
        // The bounds leave room for the query set the plan requires (≥ 250) and
        // for the one committed today, so a reviewed expansion never has to
        // touch the runner.
        expect(committed.queries.length).toBeGreaterThanOrEqual(250);
    });

    it('tolerates unknown keys at every level it reads', () => {
        const document = validDocument({
            description: 'a curation note',
            kinds: [{ kind: 'exact', definition: 'the food’s own name' }],
            protocol: { ...makeBenchmark().protocol, measuredUnit: 'catalog.service.searchPublishedFoods' },
            paginationCheck: { ...makeBenchmark().paginationCheck, referenceMode: 'in_process' },
        });

        expect(assertSearchBenchmarkShape(document)).toBe(document);
    });

    // Each row builds the whole document, so the case reads as the document a
    // run would actually be handed rather than as a patch a helper applies.
    it.each<[string, () => unknown, string]>([
        ['a top level that is not an object', () => null, 'field=its top level'],
        ['a top level that is an array', () => [], 'field=its top level'],
        ['a top level that is a string', () => '{}', 'field=its top level'],
        ['a missing thresholds block', () => validDocument({ thresholds: undefined }), 'field=thresholds'],
        [
            'a hit rate above one',
            () => validDocument({ thresholds: { ...PERMISSIVE_THRESHOLDS, topThreeHitRate: 1.5 } }),
            'field=thresholds.topThreeHitRate',
        ],
        [
            'a hit rate that is not a number',
            () => validDocument({ thresholds: { ...PERMISSIVE_THRESHOLDS, topTenHitRate: '0.97' } }),
            'field=thresholds.topTenHitRate',
        ],
        [
            'a rate finer than the scale every verdict is compared at',
            () => validDocument({ thresholds: { ...PERMISSIVE_THRESHOLDS, maxZeroResultRate: 0.0300001 } }),
            'field=thresholds.maxZeroResultRate',
        ],
        [
            'a latency bound of zero',
            () => validDocument({ thresholds: { ...PERMISSIVE_THRESHOLDS, p95LatencyMs: 0 } }),
            'field=thresholds.p95LatencyMs',
        ],
        [
            'a fractional measured page size',
            () => validDocument({ thresholds: { ...PERMISSIVE_THRESHOLDS, latencyLimit: 25.5 } }),
            'field=thresholds.latencyLimit',
        ],
        [
            'a measured page size of zero',
            () => validDocument({ thresholds: { ...PERMISSIVE_THRESHOLDS, latencyLimit: 0 } }),
            'field=thresholds.latencyLimit',
        ],
        [
            'a measured page size past the in-process ceiling',
            () => validDocument({ thresholds: { ...PERMISSIVE_THRESHOLDS, latencyLimit: 5000 } }),
            'field=thresholds.latencyLimit',
        ],
        ['an ordering that is not an array', () => validDocument({ ordering: 'ts_rank DESC' }), 'field=ordering'],
        ['an ordering clause that is not a string', () => validDocument({ ordering: [1] }), 'field=ordering[0]'],
        ['an empty reportedConditions list', () => validDocument({ reportedConditions: [] }), 'field=reportedConditions'],
        [
            'a negative warm-up pass count',
            () => validDocument({ protocol: { ...makeBenchmark().protocol, warmupPasses: -1 } }),
            'field=protocol.warmupPasses',
        ],
        [
            'no timed passes',
            () => validDocument({ protocol: { ...makeBenchmark().protocol, timedPasses: 0 } }),
            'field=protocol.timedPasses',
        ],
        [
            'a timed pass count that would never finish',
            () => validDocument({ protocol: { ...makeBenchmark().protocol, timedPasses: 1_000_000 } }),
            'field=protocol.timedPasses',
        ],
        [
            'a sequential flag that is not a boolean',
            () => validDocument({ protocol: { ...makeBenchmark().protocol, sequential: 'yes' } }),
            'field=protocol.sequential',
        ],
        [
            'a connection count of zero',
            () => validDocument({ protocol: { ...makeBenchmark().protocol, connections: 0 } }),
            'field=protocol.connections',
        ],
        [
            'an empty timing name',
            () => validDocument({ protocol: { ...makeBenchmark().protocol, timing: '' } }),
            'field=protocol.timing',
        ],
        ['no queries at all', () => validDocument({ queries: [] }), 'field=queries'],
        ['a queries member that is not an array', () => validDocument({ queries: {} }), 'field=queries'],
        [
            'more queries than a run could sweep',
            () =>
                validDocument({
                    queries: Array.from({ length: 2001 }, (_unused, index) =>
                        query(`q${index}`, 'coffee', ['usda:1']),
                    ),
                }),
            'field=queries',
        ],
        [
            'a query that is not an object',
            () => validDocument({ queries: [{ ...query('q001', 'coffee', ['usda:1']) }, 'q002'] }),
            'field=queries[1]',
        ],
        ['an id that is not a string', () => withBrokenQuery({ id: 42 }), 'field=queries[1].id'],
        ['an id longer than an id', () => withBrokenQuery({ id: 'q'.repeat(17) }), 'field=queries[1].id'],
        ['a q that is missing', () => withBrokenQuery({ q: undefined }), 'field=queries[1].q'],
        ['a q that is not a string', () => withBrokenQuery({ q: ['tea'] }), 'field=queries[1].q'],
        ['a kind that is not a string', () => withBrokenQuery({ kind: 42 }), 'field=queries[1].kind'],
        ['a kind wider than a rollup label', () => withBrokenQuery({ kind: 'k'.repeat(33) }), 'field=queries[1].kind'],
        ['an expected list that is empty', () => withBrokenQuery({ expected: [] }), 'field=queries[1].expected'],
        ['an expected list that is not an array', () => withBrokenQuery({ expected: 'usda:2' }), 'field=queries[1].expected'],
        [
            'an expectation that is not a source_key string',
            () => withBrokenQuery({ expected: ['usda:2', 17] }),
            'field=queries[1].expected[1]',
        ],
        [
            'an expectation carrying a control character',
            () => withBrokenQuery({ expected: ['usda:\u00022'] }),
            'field=queries[1].expected[0]',
        ],
        [
            'a pagination limit that is not an integer',
            () => validDocument({ paginationCheck: { ...makeBenchmark().paginationCheck, limit: 25.5, singlePageLimit: 76.5 } }),
            'field=paginationCheck.limit',
        ],
        [
            'more pagination pages than a check could walk',
            () => validDocument({ paginationCheck: { ...makeBenchmark().paginationCheck, pages: 1000, singlePageLimit: 25_000 } }),
            'field=paginationCheck.pages',
        ],
        [
            'a reference page that is not the pages it is compared against',
            () => validDocument({ paginationCheck: { ...makeBenchmark().paginationCheck, singlePageLimit: 50 } }),
            'field=paginationCheck.singlePageLimit',
        ],
        [
            'a pagination id that is not a string',
            () => validDocument({ paginationCheck: { ...makeBenchmark().paginationCheck, queryIds: [7] } }),
            'field=paginationCheck.queryIds[0]',
        ],
        [
            'a pagination id the list already names',
            () => validDocument({ paginationCheck: { ...makeBenchmark().paginationCheck, queryIds: ['q001', 'q001'] } }),
            'field=paginationCheck.queryIds[1]',
        ],
    ])('refuses %s', (_description, buildDocument, expectedField) => {
        const refusal = shapeRefusalFor(buildDocument());

        expect(refusal.code).toBe('query_set_invalid');
        expect(refusal.detail[0]).toBe(expectedField);
        // Every refusal carries the rule and the fixed remedy beside the field,
        // which is the whole of what the log line may say.
        expect(refusal.detail).toHaveLength(3);
        expect(refusal.detail[2]).toContain('search-benchmark.v1.json');
    });

    it('refuses a query the search layer would itself refuse, and says so', () => {
        // One character matches most of a ten-thousand-item catalog, which is
        // why `parseCatalogSearchQuery` refuses it for a request; a benchmark
        // query it would refuse cannot be measured either.
        const belowTheFloor = shapeRefusalFor(withBrokenQuery({ q: 'c' }));
        expect(belowTheFloor.detail[0]).toBe('field=queries[1].q');
        expect(belowTheFloor.detail[1]).toContain('a query the search layer itself accepts');

        const aboveTheCeiling = shapeRefusalFor(withBrokenQuery({ q: 'c'.repeat(61) }));
        expect(aboveTheCeiling.detail[0]).toBe('field=queries[1].q');

        // Accepted at the search layer's own boundaries, so the bounds are
        // ITS bounds rather than a second, stricter rule.
        expect(assertSearchBenchmarkShape(withBrokenQuery({ q: 'co' }))).toBeDefined();
        expect(assertSearchBenchmarkShape(withBrokenQuery({ q: 'c'.repeat(60) }))).toBeDefined();
    });

    it('refuses a query that is not exactly what would be searched', () => {
        // The parser trims; `runPass` does not. A `q` that passes validation
        // only after trimming would be sent to the service in its untrimmed
        // form — a different query from the one that was checked.
        expect(shapeRefusalFor(withBrokenQuery({ q: ' coffee' })).detail[0]).toBe('field=queries[1].q');
        expect(shapeRefusalFor(withBrokenQuery({ q: 'coffee ' })).detail[0]).toBe('field=queries[1].q');
        expect(shapeRefusalFor(withBrokenQuery({ q: 'ice\tcoffee' })).detail[0]).toBe('field=queries[1].q');
    });

    it('refuses a repeated query id, which would score a query nobody measured', () => {
        const refusal = shapeRefusalFor(
            validDocument({
                queries: [{ ...query('q001', 'coffee', ['usda:1']) }, { ...query('q001', 'tea', ['usda:2']) }],
            }),
        );

        expect(refusal.detail[0]).toBe('field=queries[1].id');
        expect(refusal.detail[1]).toContain('repeats an id an earlier query already declares');
    });

    it('names the field and the rule but never the value it refused', () => {
        // The value is the thing this check distrusts: a NUL cannot exist in a
        // PostgreSQL text parameter at all, and echoing the string into a
        // refusal would put it in the operator's terminal, in CI retention and
        // in the durable run log (CWE-117/CWE-532).
        const hostile = 'co\u0000ffee-MARKER-\u202edeifitsuj';
        const refusal = shapeRefusalFor(withBrokenQuery({ q: hostile }));
        const serialised = JSON.stringify({
            code: refusal.code,
            items: refusal.detail,
            message: refusal.message,
        });

        expect(refusal.detail[0]).toBe('field=queries[1].q');
        expect(serialised).not.toContain('MARKER');
        expect(serialised).not.toContain('\\u0000');
        expect(serialised).not.toContain('\\u202e');
    });

    it('reports a malformed query set as a prerequisite gap, before any connection is opened', () => {
        // preflight is the first thing main does after parsing its flags, and a
        // gap makes it return 1 — ahead of the release manifest, the pool pin,
        // the dynamic Prisma import and the stage lock.
        const gaps = preflight({
            loadSearchBenchmark: () => withBrokenQuery({ q: 'c' }) as unknown as SearchBenchmark,
            fileExists: () => true,
        });

        expect(gaps).toHaveLength(1);
        expect(gaps[0].code).toBe('search_benchmark_invalid');
        expect(gaps[0].detail).toContain('field=queries[1].q');
        // The gap states the remedy in its own field, so the detail carries the
        // fault alone rather than repeating it.
        expect(gaps[0].remedy).toContain('search-benchmark.v1.json');
        expect(gaps[0].detail).not.toContain('run the stage again');
    });

    it('reports a query set that passes as no gap at all', () => {
        expect(
            preflight({
                loadSearchBenchmark: () => validDocument() as unknown as SearchBenchmark,
                fileExists: () => true,
            }),
        ).toEqual([]);
    });

    it('stops a malformed query set before one query runs or one map is built', async () => {
        // main's order, as main takes it: validate the loaded document, and only
        // then measure with it. The spies are what prove the second step is
        // unreachable — no search call, no statement, and no artefact.
        const searched: string[] = [];
        const db = makeDb({ foods: THREE_FOODS });
        const outPath = tempOutPath();
        const measureIfAccepted = async (document: unknown): Promise<BenchmarkOutcome> => {
            const benchmark = assertSearchBenchmarkShape(document);
            return runBenchmark(
                makeDeps({
                    db,
                    benchmark,
                    outPath,
                    search: async (q: string): Promise<SearchPage> => {
                        searched.push(q);
                        return { items: [], total: 0 };
                    },
                }),
            );
        };

        // A NUL in `q` reaches `plainto_tsquery` as a bound parameter and
        // aborts the statement mid-measurement (SQLSTATE 22021) when nothing
        // refuses it first.
        const refusal = await refusalOf(measureIfAccepted(withBrokenQuery({ q: 'co\u0000ffee' })));

        expect(refusal.code).toBe('query_set_invalid');
        expect(searched).toEqual([]);
        expect(db.statements).toEqual([]);
        expect(fs.existsSync(outPath)).toBe(false);

        // The same path with a document that passes does measure, so the test
        // above is a gate rather than a broken harness.
        await measureIfAccepted(validDocument());
        expect(searched).toEqual(['coffee', 'tea', 'milk', 'coffee', 'tea', 'milk', 'coffee', 'tea', 'milk', 'coffee', 'tea', 'milk']);
    });
});

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

/* ---------------------------------------------------------------------------
 * The usage block, under a database this policy refuses
 * ------------------------------------------------------------------------- */

// WHY A READ-ONLY STAGE NEEDS THIS CASE AT ALL. `search-benchmark` runs under
// the widest policy in the pipeline, `read_only_recognised`, because §0.7.5
// runs it ON the deployment host to record that environment's own report — so
// the origins it refuses are the two it cannot classify or must never touch: an
// unrecognised one, and the shadow database Prisma's schema tooling resets.
// Those are the states an operator is in when they have just been handed the
// command and no URL, which is when `--help` matters: the usage block is where
// the flags, the artefact path and the acceptance protocol are written. The
// guard asserted the origin at module load, ahead of this runner's `parseArgs`,
// so it printed a refusal instead. `scripts/lib/dbGuard.ts` now skips the
// assertion for a help invocation decided from argv alone, and the pair of
// cases below is this runner's half of that claim: usage reachable with a help
// flag, the same refusal without one. The policy table itself, and which class
// each script accepts, stay in `dbGuard.test.ts`.
//
// It spawns because `require.main === module` guards `main()` and this file has
// already imported the runner, so an exit status is not observable in process.
// No database is reached: the help path returns before the lazy
// `import('../src/prisma/client')`, and the refusal precedes `main()`.
describe('reaching the usage block while the origin is refused', () => {
    /** `<repo>/backend`, three levels above this file. */
    const BACKEND_ROOT = path.resolve(__dirname, '..', '..', '..');

    const SCRIPT = path.join(BACKEND_ROOT, 'scripts', 'search-benchmark.ts');

    /** ts-node compiles the whole runner in the child; a minute is generous. */
    const CHILD_TIMEOUT_MS = 60_000;

    /**
     * The two origins this policy refuses, as URLs no server answers.
     *
     * `127.0.0.2` is outside the guard's local-host set, so it classifies
     * `unknown` and is refused outright; the `_shadow` name on loopback is
     * refused whatever the policy says, because the schema tooling resets that
     * database. Neither database exists on the test container, so a regression
     * that let a run past the guard fails on a refused connection or a missing
     * database in milliseconds instead of querying anything real — and this
     * runner only ever reads, so there is nothing to undo either way. The
     * userinfo is a placeholder: no connection is opened on either path.
     */
    const REFUSED_TARGETS: readonly { readonly code: string; readonly label: string; readonly url: string }[] = [
        {
            code: 'unrecognised_origin',
            label: 'a host the guard cannot classify',
            url: 'postgresql://benchmark_fixture:fixture-only@127.0.0.2:5432/state_of_health',
        },
        {
            code: 'shadow_database',
            label: 'the shadow class, refused to every script',
            url: 'postgresql://benchmark_fixture:fixture-only@127.0.0.1:5433/help_reachability_shadow',
        },
    ];

    interface CliOutcome {
        readonly status: number | null;
        readonly stdout: string;
        readonly stderr: string;
    }

    /**
     * The real command against one refused URL.
     *
     * `DATABASE_URL` is SET rather than inherited: `lib/bootstrap.ts` calls
     * `dotenv.config()` without override, so a child without one falls back to
     * `backend/.env`, whose `_test` database this policy ACCEPTS — the case
     * would then prove nothing at all. No vendor key is passed because neither
     * path reads one.
     */
    const runCommand = (databaseUrl: string, args: readonly string[]): CliOutcome => {
        const child = spawnSync(
            process.execPath,
            ['--require', 'ts-node/register/transpile-only', SCRIPT, ...args],
            {
                cwd: BACKEND_ROOT,
                encoding: 'utf8',
                timeout: CHILD_TIMEOUT_MS,
                env: {
                    PATH: process.env.PATH,
                    HOME: process.env.HOME,
                    DATABASE_URL: databaseUrl,
                    TS_NODE_PROJECT: 'tsconfig.scripts.json',
                    TS_NODE_TRANSPILE_ONLY: '1',
                },
            },
        );

        expect(child.error).toBeUndefined();

        return { status: child.status, stdout: child.stdout, stderr: child.stderr };
    };

    for (const target of REFUSED_TARGETS) {
        describe(target.label, () => {
            it.each([
                ['--help', ['--help']],
                ['-h', ['-h']],
                // A help flag written after real options, which is how an
                // operator mid-command asks what the rest of them are.
                ['--passes 3 --help', ['--passes', '3', '--help']],
            ])('prints the usage block and exits 0 for %s', (_label, args) => {
                const outcome = runCommand(target.url, args);

                expect(outcome.status).toBe(0);
                expect(outcome.stdout.split('\n')[0]).toBe(
                    'Usage: npm run search:benchmark -- [options]   (search-benchmark)',
                );
                expect(outcome.stdout).not.toContain('database_origin_refused');
                expect(outcome.stderr).toBe('');
                // The usage block names the artefact this runner writes, which
                // is the reason an operator reads it before running anything.
                expect(outcome.stdout).toContain('benchmark-report.json');
            }, CHILD_TIMEOUT_MS);

            it(`still refuses that database with ${target.code}, and writes no usage, when no help flag is given`, () => {
                const outcome = runCommand(target.url, []);

                expect(outcome.status).toBe(1);
                expect(outcome.stderr).toContain('"event":"database_origin_refused"');
                expect(outcome.stderr).toContain('"script":"search-benchmark"');
                expect(outcome.stderr).toContain(`"code":"${target.code}"`);
                expect(outcome.stdout).toBe('');
                expect(outcome.stderr).not.toContain('Usage: npm run');
            }, CHILD_TIMEOUT_MS);
        });
    }

    it('refuses --help=x, which this parser does not read as help either', () => {
        const outcome = runCommand(REFUSED_TARGETS[0].url, ['--help=x']);

        expect(outcome.status).toBe(1);
        expect(outcome.stderr).toContain('"event":"database_origin_refused"');
        expect(outcome.stdout).toBe('');
    }, CHILD_TIMEOUT_MS);
});
