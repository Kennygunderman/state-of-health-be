/**
 * The catalog release exporter — `scripts/catalog-release.ts` — on injected
 * doubles.
 *
 * WHY THIS SUITE EXISTS BESIDE `catalog-import.test.ts`. That file already
 * drives `releaseStalenessReason` and the `runRelease` prerequisite pairing
 * against a real ledger, and it keeps doing so. What it cannot reach is the
 * half of the stage that decides what is WRITTEN and what is PUBLISHED: the
 * component closure, the measured model provenance, the overwrite rule, the
 * ledger's states and the filesystem the staged bytes pass through. Most of
 * that is a decision over injected data — a fake `ReleaseDb` whose
 * `$transaction` hands itself back, a fake filesystem of maps — so nothing here
 * needs PostgreSQL, a database connection or a network call of any kind. The
 * cases about symbolic links, exclusive creates and
 * directory identity run against a real temporary tree instead, because a
 * double cannot refuse a link it was never asked to model; they are the only
 * part of the file that touches a disk, and the whole of it still runs in a
 * couple of seconds.
 *
 * WHAT EACH BLOCK IS ABOUT:
 *
 *   * a release's components close over its own foods — a composition naming a
 *     food the release does not export would be a member referencing a key
 *     absent from `foods.jsonl`, which `catalog-load.ts` refuses with
 *     `component_reference_unresolved` in a fresh database and, worse, resolves
 *     against whatever a non-fresh one happens to hold;
 *   * `model_versions` is measured — from the generation batches the exported
 *     rows carry and the `llm_review` records their validation records carry,
 *     never from the coverage plan, whose model blocks are env-var selection
 *     configuration and not evidence that any call was made;
 *   * publication enforces `--force` and serialises by final path — preflight
 *     runs minutes before publication on a full catalog, so two runs can both
 *     pass it;
 *   * the staging directory is created and never adopted — its name carries a
 *     nonce, it is brought into existence with an exclusive create under a
 *     parent no other local principal can write into, every member write is an
 *     exclusive no-follow open, and the directory's `(dev, ino)` identity is
 *     verified again immediately before every member open, every read-back, the
 *     manifest write and the rename that publishes it, so neither a name
 *     pre-placed as a symbolic link nor a directory swapped for one mid-export
 *     can redirect a single byte of a release. The release path itself is
 *     resolved through the symbolic links above it, so those checks are applied
 *     to a physical place rather than to a spelling;
 *   * the ledger row opens 'running' and closes only after publication, so
 *     'succeeded' in that ledger is a statement about bytes at a reviewed path;
 *   * a restricted validation pass that moved the published set after the
 *     canonical one invalidates the canonical certification.
 *
 * Run it with:
 *
 *   NODE_ENV=test ALLOW_DB_TRUNCATE=true \
 *     DATABASE_URL=postgresql://…@127.0.0.1:5433/<name>_test \
 *     npx jest src/__tests__/scripts/catalog-release.test.ts --runInBand
 */
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
    CatalogReleaseError,
    RELEASE_DATA_FILES,
    RELEASE_MANIFEST_FILE_NAME,
    ReleaseIntegrityError,
    ReleasePublicationError,
    nodeReleaseFileSystem,
    orphanStagingPid,
    pidIsRunning,
    publicationLockFor,
    publishRelease,
    releaseAcceptanceVerdict,
    releaseStalenessReason,
    resolveReleaseDir,
    runRelease,
    runReleaseStage,
    stagingDirFor,
    stagingPrefixFor,
    sweepOrphanStagingDirectories,
    validationDispositionChanges,
} from '../../../scripts/catalog-release';
import type {
    CatalogReleaseManifestWithEvidence,
    PublishReleaseInput,
    ReleaseAcceptanceVerdict,
    ReleaseDb,
    ReleaseDirectoryIdentity,
    ReleaseFileSystem,
    ReleaseFoodRow,
    ReleaseOutcome,
    ReleaseRunRow,
    RunReleaseDeps,
    RunReleaseStageDeps,
} from '../../../scripts/catalog-release';
import type { SourceCacheRow } from '../../../scripts/lib/catalogEvidence';
// The digest helpers the import stage writes `body_sha256` and `record_sha256`
// with, so the doubles' evidence resolves against the cached payload below
// exactly as a real row's does.
import { canonicalJsonString, sha256Hex } from '../../../scripts/lib/catalogFoodFacts';
import { canonicalValidationRunKey, catalogInputIdentity } from '../../../scripts/lib/checkpoint';
import type { CatalogInputRunRow } from '../../../scripts/lib/checkpoint';
import type { ScriptLogger } from '../../../scripts/lib/logger';
import {
    ManifestError,
    assertCoveragePlanModelShape,
    clearManifestCache,
    loadCoveragePlan,
    releaseDir,
} from '../../../scripts/lib/manifest';
import type { CatalogReleaseManifest, CoveragePlan } from '../../../scripts/lib/manifest';

const RELEASE = 'v99';
const FINAL_DIRECTORY = '/releases/v99';
const PID = 4242;
const NOW = new Date('2026-09-16T10:00:00.000Z');

/**
 * The staging directory's unguessable component, FIXED for this suite.
 *
 * A run takes 16 hex characters from the CSPRNG per staging directory, which is
 * what stops another local principal from pre-placing that name as a symbolic
 * link. A suite has to know which path a member was written to, so it injects
 * the component instead — `stagingSuffix` on the stage deps, the third argument
 * to `stagingDirFor` — and the unguessability of the production name is pinned
 * separately by the cases that call `stagingDirFor` with no suffix at all.
 */
const STAGING_SUFFIX = 'a1b2c3d4e5f60789';
const STAGING_DIRECTORY = stagingDirFor(FINAL_DIRECTORY, PID, STAGING_SUFFIX);

const INGEST_AT = new Date('2026-09-16T08:00:00.000Z');
const VALIDATED_AT = new Date('2026-09-16T09:00:00.000Z');

/**
 * The part of the restricted-validation remedy that must appear in every one of
 * its refusals. Re-running `catalog:validate` against the same input and plan is
 * the completed-run no-op, so naming it would send an operator in a circle —
 * these are the routes that actually mint a new canonical run.
 */
const RESTRICTED_REMEDY_PHRASE = 'newer catalog:import or catalog:load';

/** A logger that records, so a rule's own diagnostics are assertable. */
const recordingLogger = (): { readonly lines: { level: string; event: string; fields: unknown }[]; logger: ScriptLogger } => {
    const lines: { level: string; event: string; fields: unknown }[] = [];
    const at =
        (level: string) =>
        (event: string, fields?: unknown): void => {
            lines.push({ level, event, fields });
        };
    const logger = {
        debug: at('debug'),
        info: at('info'),
        warn: at('warn'),
        error: at('error'),
        child: (): ScriptLogger => logger,
    } as unknown as ScriptLogger;
    return { lines, logger };
};

const silentLogger = recordingLogger().logger;

// ---------------------------------------------------------------------------
// The doubles.
// ---------------------------------------------------------------------------

type ValidationRecordRow = NonNullable<ReleaseFoodRow['catalog_validation_records']>;

/**
 * The cached vendor response the published doubles' digests are taken over.
 *
 * WHY THE DIGESTS ARE COMPUTED AND NOT SPELLED OUT. The exporter now RESOLVES
 * every published USDA row's `source_cache_key` against `usda_api_cache` and
 * recomputes both digests from the stored payload, so a constant like
 * `'a'.repeat(64)` is no longer a publishable record: it is well-formed and
 * stands for nothing, which is exactly what that gate refuses. Every double
 * below therefore carries the digests of THIS payload, taken with the two
 * helpers `catalog-import-usda.ts` uses — the sha256 of the key-sorted JSON of
 * the whole response, and of this food's own record inside it.
 */
const CACHE_KEY = 'POST /foods?#{"fdcIds":[1],"format":"full"}';

const CACHE_RECORD: Record<string, unknown> = {
    fdcId: 1,
    description: 'Carrots, raw',
    dataType: 'SR Legacy',
    foodNutrients: [{ nutrient: { number: '208' }, amount: 41 }],
};

const CACHE_PAYLOAD: Record<string, unknown>[] = [CACHE_RECORD];

const BODY_DIGEST = sha256Hex(canonicalJsonString(CACHE_PAYLOAD));
const RECORD_DIGEST = sha256Hex(canonicalJsonString(CACHE_RECORD));

/** The `usda_api_cache` row the doubles' evidence cites, as the table holds it. */
const cacheRowFor = (overrides: Partial<SourceCacheRow> = {}): SourceCacheRow => ({
    cache_key: CACHE_KEY,
    payload: CACHE_PAYLOAD,
    http_status: 200,
    ...overrides,
});

/**
 * A complete USDA retrieval record, spelled exactly as `catalog-import-usda.ts`
 * writes one into `catalog_validation_records.identity_evidence`.
 *
 * WHY EVERY PUBLISHED DOUBLE CARRIES ONE. The exporter now applies the
 * identity-evidence floor to each published row it emits, so a record with no
 * observed status (or no digest, or no cache key) refuses the release — which is
 * the behaviour the block at the end of this file pins. That makes complete
 * evidence part of what a PUBLISHABLE row is, and every double above that is
 * meant to export has to carry it, the same way each already carries a default
 * portion with a usable gram weight.
 */
const usdaEvidence = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
    url: 'https://api.nal.usda.gov/fdc/v1/foods',
    method: 'POST',
    request_body: { fdcIds: [1], format: 'full' },
    final_host: 'api.nal.usda.gov',
    http_status: 200,
    source_cache_key: CACHE_KEY,
    retrieval_source: 'import_run',
    body_sha256: BODY_DIGEST,
    record_sha256: RECORD_DIGEST,
    matched_snippet: 'Carrots, raw',
    fetched_at: '2026-09-16T08:00:00.000Z',
    ...overrides,
});

/** A complete reference-page record, as `evidence.service.ts` returns one for a generated food. */
const pageEvidence = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
    url: 'https://fdc.nal.usda.gov/food-details/1234/nutrients',
    finalHost: 'fdc.nal.usda.gov',
    status: 200,
    bodySha256: BODY_DIGEST,
    matchedSnippet: 'seed cluster, prepared',
    fetchedAt: '2026-09-16T08:00:00.000Z',
    ...overrides,
});

const validationRecord = (overrides: Partial<ValidationRecordRow> = {}): ValidationRecordRow => ({
    canonical_identity: { name: 'x' },
    aliases: [],
    category: 'produce_vegetable',
    food_state: 'raw',
    identity_source: 'usda',
    identity_status: 'verified',
    nutrition_provenance: 'source_backed',
    nutrition_method: 'usda_record',
    nutrition_assumptions: null,
    portion_units: [],
    identity_evidence: [usdaEvidence()],
    checks: [{ name: 'kcal_bound', pass: true, observed: 30, bound: 900 }],
    llm_review: null,
    outcome: 'accepted',
    reviewed_at: VALIDATED_AT,
    publication_status: 'published',
    source_versions: {},
    history: [],
    ...overrides,
});

const publishedFood = (overrides: Partial<ReleaseFoodRow> = {}): ReleaseFoodRow => ({
    source_key: 'usda:1',
    canonical_name: 'carrot',
    display_name: 'Carrot, raw',
    category: 'produce_vegetable',
    food_state: 'raw',
    food_group: 'carrot',
    identity_source: 'usda',
    identity_status: 'verified',
    nutrition_provenance: 'source_backed',
    publication_status: 'published',
    nutrition_basis: 'per_100g',
    basis_amount: 100,
    calories: 41,
    protein_g: 0.9,
    carbs_g: 9.6,
    fat_g: 0.2,
    fiber_g: 2.8,
    density_g_per_ml: null,
    allergen_tags: [],
    allergen_status: 'known',
    diet_tags: ['vegan'],
    is_common_dislike: false,
    cost_class: 1,
    nutrition_version: 1,
    metadata_version: 1,
    usda_fdc_id: 1,
    usda_data_type: 'SR Legacy',
    usda_description: 'Carrots, raw',
    source_version: 'SR Legacy 2019-04',
    source_cache_key: 'cache:1',
    search_text: 'carrot',
    imported_at: INGEST_AT,
    catalog_generation_batches: null,
    catalog_food_aliases: [{ alias: 'Carrots' }],
    catalog_food_portions: [
        { description: '1 cup chopped', amount: 1, unit: 'cup', gram_weight: 128, is_default: true, source: 'usda' },
    ],
    catalog_food_components: [],
    catalog_validation_records: validationRecord(),
    ...overrides,
});

/** The ledger a release is allowed to be cut from: one ingest, then its canonical validation. */
const readyLedger = (extra: readonly ReleaseRunRow[] = []): ReleaseRunRow[] => {
    const ingest: ReleaseRunRow = {
        kind: 'usda_import',
        manifest_version: 'the-import',
        status: 'succeeded',
        finished_at: INGEST_AT,
    };
    const validation: ReleaseRunRow = {
        kind: 'validation',
        manifest_version: canonicalValidationRunKey(
            'v1',
            catalogInputIdentity([ingest as unknown as CatalogInputRunRow]),
        ),
        status: 'succeeded',
        finished_at: VALIDATED_AT,
        counts: { judged: 1, unchanged: 1 },
    };
    return [ingest, validation, ...extra];
};

const canonicalKeyFor = (runs: readonly ReleaseRunRow[]): string =>
    canonicalValidationRunKey('v1', catalogInputIdentity(runs as unknown as CatalogInputRunRow[]));

interface FakeDb extends ReleaseDb {
    readonly created: Record<string, unknown>[];
    readonly updated: { where: unknown; data: Record<string, unknown> }[];
    /** Every call the orchestration makes, in order, so ordering is assertable. */
    readonly calls: string[];
    failNextUpdate?: boolean;
}

/**
 * The cache rows a `FakeDb` answers with, keyed as the table is.
 *
 * Defaults to the one row every published double's evidence cites, so the
 * ordinary export resolves; the tamper cases pass their own map (or an empty
 * one) to make a binding fail in exactly one way.
 */
const defaultCacheRows = (): Map<string, SourceCacheRow> => new Map([[CACHE_KEY, cacheRowFor()]]);

const fakeDb = (
    foods: readonly ReleaseFoodRow[],
    runs: readonly ReleaseRunRow[],
    calls: string[] = [],
    cacheRows: ReadonlyMap<string, SourceCacheRow> = defaultCacheRows(),
): FakeDb => {
    const created: Record<string, unknown>[] = [];
    const updated: { where: unknown; data: Record<string, unknown> }[] = [];
    const sorted = [...foods].sort((left, right) => (left.source_key < right.source_key ? -1 : 1));

    const db: FakeDb = {
        created,
        updated,
        calls,
        catalog_foods: {
            findMany: async (args: unknown): Promise<ReleaseFoodRow[]> => {
                const query = args as {
                    where: { source_key?: { gt: string } };
                    take: number;
                };
                const after = query.where.source_key?.gt;
                const page = sorted
                    .filter((food) => after === undefined || food.source_key > after)
                    .slice(0, query.take);
                return page;
            },
        },
        usda_api_cache: {
            // Honours the `where: { cache_key: { in: [...] } }` the exporter
            // sends, so a key the map does not hold comes back as no row —
            // which is the unknown-cache-key case rather than a harness
            // shortcut.
            findMany: async (args: unknown): Promise<SourceCacheRow[]> => {
                calls.push('cache:findMany');
                const query = args as { where: { cache_key: { in: readonly string[] } } };
                return query.where.cache_key.in
                    .map((key) => cacheRows.get(key))
                    .filter((row): row is SourceCacheRow => row !== undefined);
            },
        },
        catalog_import_runs: {
            create: async (args: unknown): Promise<{ id: string }> => {
                calls.push('ledger:create');
                created.push((args as { data: Record<string, unknown> }).data);
                return { id: `run-${created.length}` };
            },
            update: async (args: unknown): Promise<{ id: string }> => {
                calls.push('ledger:update');
                if (db.failNextUpdate === true) {
                    throw new Error('ledger unreachable');
                }
                updated.push(args as { where: unknown; data: Record<string, unknown> });
                return { id: 'run-1' };
            },
            findMany: async (): Promise<ReleaseRunRow[]> => [...runs],
        },
        $transaction: async <T>(work: (tx: ReleaseDb) => Promise<T>): Promise<T> => work(db),
    };
    return db;
};

interface FakeFileSystem extends ReleaseFileSystem {
    readonly files: Map<string, string>;
    readonly directories: Set<string>;
    /** `(dev, ino)` per directory, so an identity that CHANGED is expressible. */
    readonly identities: Map<string, ReleaseDirectoryIdentity>;
    /**
     * Names that exist and are not directories, however they resolve — the
     * in-memory stand-in for a symbolic link. `directoryIdentity` answers
     * `null` for them and an exclusive create refuses them, which is the whole
     * of what this stage decides about such an entry.
     */
    readonly symlinks: Set<string>;
    readonly locks: Set<string>;
    readonly actions: string[];
    lockHeldByAnother?: boolean;
    /** One `from->to` move to refuse, so a rollback's own move still works. */
    failRename?: string;
    /** Directories `assertSafeParent` refuses, as a hostile parent's mode would. */
    readonly unsafeParents: Set<string>;
}

const fakeFileSystem = (actions: string[] = []): FakeFileSystem => {
    const files = new Map<string, string>();
    const directories = new Set<string>();
    const identities = new Map<string, ReleaseDirectoryIdentity>();
    const symlinks = new Set<string>();
    const locks = new Set<string>();
    const unsafeParents = new Set<string>();
    let nextIno = 1;

    const identify = (absolutePath: string): void => {
        if (!identities.has(absolutePath)) {
            identities.set(absolutePath, { dev: 7, ino: nextIno });
            nextIno += 1;
        }
    };

    const system: FakeFileSystem = {
        files,
        directories,
        identities,
        symlinks,
        locks,
        actions,
        unsafeParents,
        writeFile: (absolutePath, contents) => {
            files.set(absolutePath, contents);
        },
        readFileBytes: (absolutePath) => Buffer.from(files.get(absolutePath) ?? '', 'utf-8'),
        ensureDir: (absolutePath) => {
            directories.add(absolutePath);
            identify(absolutePath);
        },
        createDirectoryExclusive: (absolutePath) => {
            system.assertSafeParent(absolutePath);
            actions.push(`createDir:${absolutePath}`);
            if (directories.has(absolutePath) || symlinks.has(absolutePath) || files.has(absolutePath)) {
                throw new ManifestError(
                    'unsafe_artifact_directory',
                    `${absolutePath} already exists`,
                );
            }
            directories.add(absolutePath);
            identify(absolutePath);
        },
        listDirectoryNames: (absolutePath) => {
            const names = new Set<string>();
            for (const entry of [...directories, ...symlinks, ...files.keys()]) {
                if (entry !== absolutePath && path.dirname(entry) === absolutePath) {
                    names.add(path.basename(entry));
                }
            }
            return [...names];
        },
        directoryIdentity: (absolutePath) =>
            symlinks.has(absolutePath) || !directories.has(absolutePath)
                ? null
                : identities.get(absolutePath) ?? null,
        assertSafeParent: (absolutePath) => {
            actions.push(`safeParent:${absolutePath}`);
            if (unsafeParents.has(path.dirname(absolutePath))) {
                throw new ManifestError(
                    'unsafe_artifact_directory',
                    `${path.dirname(absolutePath)} is writable by other local principals and is not sticky`,
                );
            }
        },
        removeDir: (absolutePath) => {
            actions.push(`removeDir:${absolutePath}`);
            directories.delete(absolutePath);
            identities.delete(absolutePath);
        },
        directoryExists: (absolutePath) => directories.has(absolutePath),
        rename: (from, to) => {
            actions.push(`rename:${from}->${to}`);
            if (system.failRename === `${from}->${to}`) {
                throw new Error(`rename into ${to} refused`);
            }
            directories.delete(from);
            directories.add(to);
            const identity = identities.get(from);
            identities.delete(from);
            if (identity !== undefined) {
                // The directory is the same directory under a new name, which
                // is exactly what `rename` does and what the identity check
                // through publication rests on.
                identities.set(to, identity);
            }
        },
        createFileExclusive: (absolutePath, contents) => {
            if (system.lockHeldByAnother === true || locks.has(absolutePath)) {
                return false;
            }
            locks.add(absolutePath);
            files.set(absolutePath, contents);
            actions.push(`lock:${absolutePath}`);
            return true;
        },
        removeFile: (absolutePath) => {
            actions.push(`unlock:${absolutePath}`);
            locks.delete(absolutePath);
            files.delete(absolutePath);
        },
    };
    return system;
};

let coveragePlan: CoveragePlan;

beforeAll(() => {
    // The committed document, which also exercises the new model-shape check.
    coveragePlan = loadCoveragePlan();
});

afterEach(() => {
    clearManifestCache();
});

const exportDeps = (
    db: ReleaseDb,
    files: Map<string, string>,
    overrides: Partial<RunReleaseDeps> = {},
): RunReleaseDeps => ({
    db,
    coveragePlan,
    release: RELEASE,
    logger: silentLogger,
    now: () => NOW,
    releaseDir: () => FINAL_DIRECTORY,
    writeFile: (absolutePath, contents) => {
        files.set(absolutePath, contents);
    },
    readFileBytes: (absolutePath) => Buffer.from(files.get(absolutePath) ?? '', 'utf-8'),
    ensureDir: () => undefined,
    pageSize: 2,
    ...overrides,
});

const memberLines = (files: Map<string, string>, member: string): Record<string, unknown>[] =>
    (files.get(path.join(FINAL_DIRECTORY, member)) ?? '')
        .split('\n')
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line) as Record<string, unknown>);

const writtenManifest = (files: Map<string, string>): CatalogReleaseManifest =>
    JSON.parse(files.get(path.join(FINAL_DIRECTORY, RELEASE_MANIFEST_FILE_NAME)) as string) as CatalogReleaseManifest;

// ---------------------------------------------------------------------------

describe("a release's components close over its own foods", () => {
    const derived = (componentStatus: string): ReleaseFoodRow[] => [
        publishedFood({
            source_key: 'ai:prepared_meal:dressing:prepared',
            nutrition_provenance: 'ingredient_derived',
            identity_source: 'usda',
            catalog_food_components: [
                {
                    quantity_grams: 30,
                    yield_factor: 1,
                    component_nutrition_version: 1,
                    sort_order: 0,
                    component_catalog_foods: { source_key: 'usda:2', publication_status: componentStatus },
                },
            ],
            catalog_validation_records: validationRecord({ nutrition_provenance: 'ingredient_derived' }),
        }),
        publishedFood({ source_key: 'usda:2', publication_status: componentStatus }),
    ];

    it('exports a composition whose target the release carries', async () => {
        const files = new Map<string, string>();
        const db = fakeDb(derived('published'), readyLedger());

        const outcome = await runRelease(exportDeps(db, files));

        expect(outcome.counts.components).toBe(1);
        expect(memberLines(files, 'components.jsonl')).toEqual([
            {
                food_source_key: 'ai:prepared_meal:dressing:prepared',
                component_food_source_key: 'usda:2',
                quantity_grams: 30,
                yield_factor: 1,
                component_nutrition_version: 1,
                sort_order: 0,
            },
        ]);
        // The reference resolves, which is the claim catalog-load.ts depends on.
        const exported = memberLines(files, 'foods.jsonl').map((line) => line.source_key);
        expect(exported).toContain('usda:2');
    });

    it.each(['candidate', 'quarantined', 'retired'])(
        'refuses a release whose composition names a %s food, naming the pair',
        async (status) => {
            const files = new Map<string, string>();
            // Only the derived parent is published; its component is not.
            const rows = derived(status).filter((row) => row.publication_status === 'published');
            const db = fakeDb(rows, readyLedger());

            await expect(runRelease(exportDeps(db, files))).rejects.toThrow(ReleaseIntegrityError);
            await expect(runRelease(exportDeps(db, files))).rejects.toThrow(
                `ai:prepared_meal:dressing:prepared → usda:2 (${status})`,
            );
            // And it says what a load would do with it, so the refusal is actionable.
            await expect(runRelease(exportDeps(db, files))).rejects.toThrow('component_reference_unresolved');
        },
    );

    it('never writes the unresolvable reference into the member it would corrupt', async () => {
        const files = new Map<string, string>();
        const rows = derived('quarantined').filter((row) => row.publication_status === 'published');

        await expect(runRelease(exportDeps(fakeDb(rows, readyLedger()), files))).rejects.toThrow(
            ReleaseIntegrityError,
        );

        expect(memberLines(files, 'components.jsonl')).toEqual([]);
    });

    /**
     * A COMPOSITION WHOSE PARENT DENIES DERIVING FROM IT IS NOT EXPORTED
     * EITHER.
     *
     * `assessComponentCoverage` refuses a published `ingredient_derived` food
     * with no composition; these cases are the dual, and the reason the pair
     * matters is what a release is for. `deriveComponentNutrition` calls
     * everything it derives `ingredient_derived`, so a row emitting component
     * lines while claiming `source_backed` states two incompatible things about
     * its own numbers — and the scalars it ships were then never compared with
     * the composition beside them, because every gate keyed on the claim.
     * catalog-load.ts refuses exactly such a release
     * (`release_component_inconsistent` / `parent_provenance_disagrees`), so
     * cutting one produces bytes no environment can load; the exporter is where
     * an operator should learn that, before the release is reviewed.
     */
    const relabelled = (provenance: string): ReleaseFoodRow[] =>
        derived('published').map((row) =>
            row.source_key === 'ai:prepared_meal:dressing:prepared'
                ? {
                      ...row,
                      nutrition_provenance: provenance,
                      catalog_validation_records: validationRecord({ nutrition_provenance: provenance }),
                  }
                : row,
        );

    it.each(['source_backed', 'ai_estimated'])(
        'refuses a release carrying a composition whose parent claims %s, naming what it claims',
        async (provenance) => {
            const files = new Map<string, string>();

            await expect(runRelease(exportDeps(fakeDb(relabelled(provenance), readyLedger()), files))).rejects.toThrow(
                ReleaseIntegrityError,
            );
            await expect(runRelease(exportDeps(fakeDb(relabelled(provenance), readyLedger()), files))).rejects.toThrow(
                `ai:prepared_meal:dressing:prepared (${provenance}, 1 component row(s))`,
            );
            // And it says what a load would do with it, so the refusal is
            // actionable without reading this file.
            await expect(runRelease(exportDeps(fakeDb(relabelled(provenance), readyLedger()), files))).rejects.toThrow(
                'parent_provenance_disagrees',
            );
            await expect(runRelease(exportDeps(fakeDb(relabelled(provenance), readyLedger()), files))).rejects.toThrow(
                'npm run catalog:validate',
            );
        },
    );

    it('carries the offending food own key on the refusal, not the decorated entry', async () => {
        const files = new Map<string, string>();

        const refusal = await runRelease(exportDeps(fakeDb(relabelled('source_backed'), readyLedger()), files)).then(
            () => null,
            (error: unknown) => error as ReleaseIntegrityError,
        );

        expect(refusal).toBeInstanceOf(ReleaseIntegrityError);
        expect(refusal?.file).toBe('components.jsonl');
        expect(refusal?.sourceKey).toBe('ai:prepared_meal:dressing:prepared');
    });

    it('exports the same composition once its parent states the provenance a derivation produces', async () => {
        // The control: nothing else about the two rows changes, so the refusal
        // above can come from nothing but the provenance claim.
        const files = new Map<string, string>();

        const outcome = await runRelease(exportDeps(fakeDb(derived('published'), readyLedger()), files));

        expect(outcome.counts.components).toBe(1);
        expect(memberLines(files, 'components.jsonl')).toHaveLength(1);
    });

    it('does not let an unpublished target make a derived food look composed', async () => {
        // The stricter reading of the same defect: with the component dropped
        // and no refusal, `assessComponentCoverage` would have seen a derived
        // food with zero components — which is the other refusal, and either is
        // better than shipping it. The message must name the component cause.
        const files = new Map<string, string>();
        const rows = derived('quarantined').filter((row) => row.publication_status === 'published');

        await expect(runRelease(exportDeps(fakeDb(rows, readyLedger()), files))).rejects.toThrow(
            'name a food this release does not carry',
        );
    });
});

describe('a published row this release cannot evidence is not shipped (F01, F25)', () => {
    /**
     * A database double that honours the page query's own `where`, so the
     * published/not-published distinction is the EXPORTER's and not the
     * harness's: `releaseFoodPageQuery` selects `publication_status:
     * 'published'`, and the cases below turn on which rows that admits.
     */
    const catalogDb = (
        foods: readonly ReleaseFoodRow[],
        runs: readonly ReleaseRunRow[],
        cacheRows: ReadonlyMap<string, SourceCacheRow> = defaultCacheRows(),
        calls: string[] = [],
    ): FakeDb => {
        const db = fakeDb(foods, runs, calls, cacheRows);
        const pageQuery = db.catalog_foods.findMany;
        db.catalog_foods.findMany = async (args: unknown): Promise<ReleaseFoodRow[]> => {
            const query = args as { where: { publication_status?: string } };
            const page = await pageQuery(args);
            return page.filter(
                (food) =>
                    query.where.publication_status === undefined ||
                    food.publication_status === query.where.publication_status,
            );
        };
        return db;
    };

    const evidenceOf = (files: Map<string, string>): Record<string, unknown> =>
        (writtenManifest(files) as unknown as { evidence: Record<string, unknown> }).evidence;

    it('exports a row whose USDA retrieval record is complete, and states what it measured', async () => {
        const files = new Map<string, string>();
        const db = catalogDb([publishedFood()], readyLedger());

        const outcome = await runRelease(exportDeps(db, files));

        expect(outcome.counts.validationRecords).toBe(1);
        // The block a reviewer reads instead of streaming 56 MB of records: the
        // published rows per identity source, the statuses those retrievals
        // actually returned, and an EMPTY gap histogram — which is a measured
        // statement that the floor ran and found nothing, not a default.
        expect(evidenceOf(files)).toEqual({
            published_foods: 1,
            assessed_records: 1,
            complete_records: 1,
            observed_status_min: 200,
            observed_status_max: 200,
            identity_sources: [
                {
                    identity_source: 'usda',
                    published_foods: 1,
                    assessed_records: 1,
                    observed_status_min: 200,
                    observed_status_max: 200,
                },
            ],
            gap_codes: [],
            // AND the attestation the loader cannot re-make: the one published
            // USDA row required a source-cache binding, it resolved, and one
            // cached response was read for it.
            source_cache_resolution: {
                required_records: 1,
                resolved_records: 1,
                cache_rows_read: 1,
            },
        });
    });

    it('reads a generated row\'s reference-page record under its own spelling', async () => {
        // `evidence.service.ts` writes camelCase and the importer writes
        // snake_case; both are evidence, and the floor reads either — so a
        // release carrying one of each exports and states both sources.
        const files = new Map<string, string>();
        const generated = publishedFood({
            source_key: 'ai:snack:seed cluster:prepared',
            identity_source: 'ai_generated',
            catalog_generation_batches: {
                batch_key: 'v1:snack:0001',
                model: 'google/gemini-2.5-flash',
                prompt_version: 'catalog-generation-2026-09-08',
            },
            catalog_validation_records: validationRecord({
                identity_source: 'ai_generated',
                identity_evidence: [pageEvidence()],
            }),
        });

        await runRelease(exportDeps(catalogDb([publishedFood(), generated], readyLedger()), files));

        expect(evidenceOf(files)).toMatchObject({
            published_foods: 2,
            complete_records: 2,
            identity_sources: [
                {
                    identity_source: 'ai_generated',
                    published_foods: 1,
                    assessed_records: 1,
                    observed_status_min: 200,
                    observed_status_max: 200,
                },
                { identity_source: 'usda', published_foods: 1, assessed_records: 1 },
            ],
            gap_codes: [],
        });
    });

    it('refuses the release when a published record states no observed HTTP status', async () => {
        // The committed v1 defect exactly: every field present, `http_status`
        // null. The import stage quarantines that row, so a release must not
        // ship it as published.
        const files = new Map<string, string>();
        const rows = [
            publishedFood({
                catalog_validation_records: validationRecord({
                    identity_evidence: [usdaEvidence({ http_status: null })],
                }),
            }),
        ];

        const failure = await runRelease(exportDeps(catalogDb(rows, readyLedger()), files)).then(
            () => null,
            (error: unknown) => error,
        );

        expect(failure).toBeInstanceOf(ReleaseIntegrityError);
        const error = failure as ReleaseIntegrityError;
        expect(error.message).toContain('usda:1 (retrieval_status_missing)');
        expect(error.message).toContain('http_status');
        // The repair is a re-retrieval, never an edit of the artefact.
        expect(error.message).toContain('npm run catalog:import');
        expect(error.message).toContain('observed, never reconstructed');
        expect(error.file).toBe('validation-records.jsonl');
        expect(error.sourceKey).toBe('usda:1');
        // No manifest: the refusal lands before one is written, so nothing
        // binds those bytes as accepted evidence.
        expect(files.has(path.join(FINAL_DIRECTORY, RELEASE_MANIFEST_FILE_NAME))).toBe(false);
    });

    it.each([
        ['no body digest', { body_sha256: undefined }, 'retrieval_body_digest_missing'],
        ['a truncated body digest', { body_sha256: 'abc123' }, 'retrieval_body_digest_missing'],
        ['no usda_api_cache key', { source_cache_key: undefined }, 'retrieval_source_cache_key_missing'],
        ['no per-food record digest', { record_sha256: undefined }, 'retrieval_record_digest_missing'],
        ['no matched snippet', { matched_snippet: '   ' }, 'retrieval_snippet_missing'],
        ['a failure status', { http_status: 503 }, 'retrieval_status_invalid'],
    ])('refuses a published USDA record with %s', async (_what, overrides, code) => {
        const files = new Map<string, string>();
        const evidence = usdaEvidence();
        for (const [field, value] of Object.entries(overrides)) {
            if (value === undefined) {
                delete evidence[field];
            } else {
                evidence[field] = value;
            }
        }
        const rows = [
            publishedFood({
                catalog_validation_records: validationRecord({ identity_evidence: [evidence] }),
            }),
        ];

        const failure = await runRelease(exportDeps(catalogDb(rows, readyLedger()), files)).then(
            () => null,
            (error: unknown) => error,
        );

        expect(failure).toBeInstanceOf(ReleaseIntegrityError);
        expect((failure as ReleaseIntegrityError).message).toContain(`usda:1 (${code})`);
    });

    it('refuses a published record with no retrieval record at all, without inventing one', async () => {
        const files = new Map<string, string>();
        const rows = [publishedFood({ catalog_validation_records: validationRecord({ identity_evidence: [] }) })];

        await expect(runRelease(exportDeps(catalogDb(rows, readyLedger()), files))).rejects.toThrow(
            'usda:1 (evidence_absent)',
        );
    });

    it('does not gate a row the release does not publish', async () => {
        // The floor is a publication rule, not a catalog audit: a quarantined
        // row is exactly where a row with incomplete evidence is SUPPOSED to
        // sit, and a release that refused to exist because of one would be
        // unable to ship the rows that are evidenced.
        const files = new Map<string, string>();
        const quarantined = publishedFood({
            source_key: 'usda:2',
            publication_status: 'quarantined',
            catalog_validation_records: validationRecord({
                publication_status: 'quarantined',
                outcome: 'quarantined',
                identity_evidence: [usdaEvidence({ http_status: null })],
            }),
        });

        const outcome = await runRelease(exportDeps(catalogDb([publishedFood(), quarantined], readyLedger()), files));

        expect(outcome.publishedFoods).toBe(1);
        expect(memberLines(files, 'foods.jsonl').map((line) => line.source_key)).toEqual(['usda:1']);
        expect(evidenceOf(files)).toMatchObject({ published_foods: 1, assessed_records: 1, gap_codes: [] });
    });

    it('never promotes the staged directory of a refused export, and records the run failed', async () => {
        const db = catalogDb(
            [
                publishedFood({
                    catalog_validation_records: validationRecord({
                        identity_evidence: [usdaEvidence({ http_status: null })],
                    }),
                }),
            ],
            readyLedger(),
        );
        const system = fakeFileSystem();

        // No `runExport`/`publish` overrides: this is the orchestration main()
        // runs, so the refusal travels the path an operator's run would.
        await expect(
            runReleaseStage({
                db,
                coveragePlan,
                release: RELEASE,
                force: false,
                finalDirectory: FINAL_DIRECTORY,
                logger: silentLogger,
                now: () => NOW,
                pid: PID,
                fileSystem: system,
                // The staging name now carries a CSPRNG component, so the suite
                // injects it to know which path the run used (see STAGING_SUFFIX).
                stagingSuffix: STAGING_SUFFIX,
            }),
        ).rejects.toThrow(ReleaseIntegrityError);

        const staging = STAGING_DIRECTORY;
        expect(system.actions.filter((action) => action.startsWith('rename:'))).toEqual([]);
        expect(system.actions).toContain(`removeDir:${staging}`);
        expect(system.files.has(path.join(FINAL_DIRECTORY, RELEASE_MANIFEST_FILE_NAME))).toBe(false);
        expect(system.directoryExists(FINAL_DIRECTORY)).toBe(false);
        expect(db.updated[0].data).toMatchObject({ status: 'failed' });
        expect((db.updated[0].data.log as { code?: string }[])[1].code).toBe('release_integrity_failed');
    });
});

describe("a published row's digests have to resolve against the payload they cite (F25)", () => {
    /**
     * The same publication-honouring double the evidence block uses, with the
     * `usda_api_cache` contents under the test's control.
     *
     * WHY THIS BLOCK IS SEPARATE FROM THE EVIDENCE FLOOR ABOVE. That block is
     * about the SHAPE of a retrieval record — every mandatory field present, a
     * successful status, digests that look like digests. This one is about
     * whether that shape stands for anything: the export is the last stage that
     * can read `usda_api_cache`, so it resolves the key, recomputes both
     * digests from the stored payload and requires the record it hashed to be
     * the one belonging to this food's `usda_fdc_id`. A well-formed digest of
     * nothing passes the floor above and has to fail here.
     */
    const catalogDb = (
        foods: readonly ReleaseFoodRow[],
        runs: readonly ReleaseRunRow[],
        cacheRows: ReadonlyMap<string, SourceCacheRow> = defaultCacheRows(),
        calls: string[] = [],
    ): FakeDb => {
        const db = fakeDb(foods, runs, calls, cacheRows);
        const pageQuery = db.catalog_foods.findMany;
        db.catalog_foods.findMany = async (args: unknown): Promise<ReleaseFoodRow[]> => {
            const query = args as { where: { publication_status?: string } };
            const page = await pageQuery(args);
            return page.filter(
                (food) =>
                    query.where.publication_status === undefined ||
                    food.publication_status === query.where.publication_status,
            );
        };
        return db;
    };

    const evidenceOf = (files: Map<string, string>): Record<string, unknown> =>
        (writtenManifest(files) as unknown as { evidence: Record<string, unknown> }).evidence;

    /** A second food in the same batch response, so "another food's record" is a real record. */
    const OTHER_RECORD: Record<string, unknown> = {
        fdcId: 2,
        description: 'Carrots, cooked, boiled, drained, without salt',
        dataType: 'SR Legacy',
        foodNutrients: [{ nutrient: { number: '208' }, amount: 35 }],
    };
    const BATCH_KEY = 'POST /foods?#{"fdcIds":[1,2],"format":"full"}';
    const BATCH_PAYLOAD: Record<string, unknown>[] = [CACHE_RECORD, OTHER_RECORD];
    const BATCH_BODY_DIGEST = sha256Hex(canonicalJsonString(BATCH_PAYLOAD));
    const OTHER_RECORD_DIGEST = sha256Hex(canonicalJsonString(OTHER_RECORD));

    const rowWith = (evidenceOverrides: Record<string, unknown> = {}): ReleaseFoodRow[] => [
        publishedFood({
            catalog_validation_records: validationRecord({
                identity_evidence: [usdaEvidence(evidenceOverrides)],
            }),
        }),
    ];

    const refusalFrom = async (
        rows: readonly ReleaseFoodRow[],
        cacheRows: ReadonlyMap<string, SourceCacheRow>,
    ): Promise<ReleaseIntegrityError> => {
        const files = new Map<string, string>();
        const failure = await runRelease(exportDeps(catalogDb(rows, readyLedger(), cacheRows), files)).then(
            () => null,
            (error: unknown) => error,
        );
        expect(failure).toBeInstanceOf(ReleaseIntegrityError);
        // Nothing is published: the refusal lands before the manifest, so no
        // bytes ever bind an unresolvable digest as accepted evidence.
        expect(files.has(path.join(FINAL_DIRECTORY, RELEASE_MANIFEST_FILE_NAME))).toBe(false);
        return failure as ReleaseIntegrityError;
    };

    it('resolves the cited payload, and reads the cache to do it', async () => {
        const files = new Map<string, string>();
        const calls: string[] = [];
        const db = catalogDb([publishedFood()], readyLedger(), defaultCacheRows(), calls);

        const outcome = await runRelease(exportDeps(db, files));

        expect(outcome.publishedFoods).toBe(1);
        // The cache really was queried — the attestation below is a measurement
        // and not a constant the manifest writer filled in.
        expect(calls).toContain('cache:findMany');
        expect(evidenceOf(files)).toMatchObject({
            source_cache_resolution: { required_records: 1, resolved_records: 1, cache_rows_read: 1 },
        });
    });

    it('refuses a source_cache_key no usda_api_cache row answers to', async () => {
        // The key is well-formed and the digests are the real ones; there is
        // simply nothing to look up, so no reader could ever re-derive them.
        const error = await refusalFrom(rowWith(), new Map());

        expect(error.message).toContain('usda:1 (cache_row_absent)');
        expect(error.message).toContain('usda_api_cache.cache_key');
        expect(error.message).toContain(CACHE_KEY);
        expect(error.message).toContain('npm run catalog:import');
        expect(error.file).toBe('validation-records.jsonl');
        expect(error.sourceKey).toBe('usda:1');
    });

    it('refuses a cache row whose http_status disagrees with the evidence record', async () => {
        // 201 against a record stating 200: whichever number is right, the
        // record is describing an exchange other than the one behind the
        // payload it cites.
        const error = await refusalFrom(rowWith(), new Map([[CACHE_KEY, cacheRowFor({ http_status: 201 })]]));

        expect(error.message).toContain('usda:1 (cache_status_disagrees)');
        expect(error.message).toContain('cache row 201, evidence record 200');
    });

    it('refuses a cache row that records no status at all', async () => {
        // The committed-v1 defect one table over: the record states 200 and the
        // row it cites never observed anything, so the status is unattested at
        // the only place it could be checked.
        const error = await refusalFrom(rowWith(), new Map([[CACHE_KEY, cacheRowFor({ http_status: null })]]));

        expect(error.message).toContain('usda:1 (cache_status_missing)');
        expect(error.message).toContain('usda_api_cache.http_status');
    });

    it('refuses a body digest that is not the digest of the cited payload', async () => {
        const error = await refusalFrom(rowWith({ body_sha256: 'b'.repeat(64) }), defaultCacheRows());

        // Both digests are wrong once the body digest is fabricated? No — the
        // record digest is still the real one, so exactly the body binding is
        // named, which is what makes the diagnostic worth reading.
        expect(error.message).toContain('usda:1 (cache_body_digest_disagrees)');
        expect(error.message).toContain(`the cached payload digests to ${BODY_DIGEST}`);
    });

    it('refuses a per-food record digest that is not the digest of this food\'s record', async () => {
        const error = await refusalFrom(rowWith({ record_sha256: 'c'.repeat(64) }), defaultCacheRows());

        expect(error.message).toContain('usda:1 (cache_record_digest_disagrees)');
        expect(error.message).toContain('the cached record for fdcId 1 digests to');
    });

    it('refuses a record digest lifted from a DIFFERENT food in the same batch response', async () => {
        // The case a hex-shape check cannot see: every field is present, the
        // body digest is the real digest of the real payload, and the per-food
        // digest is a genuine sha256 — of fdcId 2's record. It evidences that
        // food and not this one.
        const error = await refusalFrom(
            rowWith({
                source_cache_key: BATCH_KEY,
                body_sha256: BATCH_BODY_DIGEST,
                record_sha256: OTHER_RECORD_DIGEST,
            }),
            new Map([[BATCH_KEY, cacheRowFor({ cache_key: BATCH_KEY, payload: BATCH_PAYLOAD })]]),
        );

        expect(error.message).toContain('usda:1 (cache_record_digest_disagrees)');
        expect(error.message).toContain(OTHER_RECORD_DIGEST);
        expect(error.message).toContain('the cached record for fdcId 1 digests to');
    });

    it('refuses a payload that does not carry this food\'s record at all', async () => {
        const error = await refusalFrom(
            rowWith({ record_sha256: OTHER_RECORD_DIGEST }),
            new Map([[CACHE_KEY, cacheRowFor({ payload: [OTHER_RECORD] })]]),
        );

        expect(error.message).toContain('usda:1 (cache_body_digest_disagrees, cache_record_absent)');
        expect(error.message).toContain('no record for fdcId 1 among 1');
    });

    it('requires no binding of a generated row, and says so by measuring none', async () => {
        // A generated row's evidence is a fetched reference page: nothing cached
        // it here, so there is no key to resolve and the attestation must not
        // claim one was. Resolving zero of zero is the honest statement.
        const files = new Map<string, string>();
        const generated = publishedFood({
            source_key: 'ai:snack:seed cluster:prepared',
            identity_source: 'ai_generated',
            usda_fdc_id: null,
            catalog_generation_batches: {
                batch_key: 'v1:snack:0001',
                model: 'google/gemini-2.5-flash',
                prompt_version: 'catalog-generation-2026-09-08',
            },
            catalog_validation_records: validationRecord({
                identity_source: 'ai_generated',
                identity_evidence: [pageEvidence()],
            }),
        });

        await runRelease(exportDeps(catalogDb([generated], readyLedger(), new Map()), files));

        expect(evidenceOf(files)).toMatchObject({
            published_foods: 1,
            source_cache_resolution: { required_records: 0, resolved_records: 0, cache_rows_read: 0 },
        });
    });
});

describe('model_versions is measured from the rows, never from configuration', () => {
    const aiFood = (overrides: Partial<ReleaseFoodRow> = {}): ReleaseFoodRow =>
        publishedFood({
            source_key: 'ai:snack:seed cluster:prepared',
            identity_source: 'ai_generated',
            catalog_generation_batches: {
                batch_key: 'v1:snack:0001',
                model: 'google/gemini-2.5-flash',
                prompt_version: 'catalog-generation-2026-09-08',
            },
            ...overrides,
        });

    it('records nulls and empty sets for a release of sourced records only', async () => {
        const files = new Map<string, string>();

        await runRelease(exportDeps(fakeDb([publishedFood()], readyLedger()), files));

        expect(writtenManifest(files).model_versions).toEqual({
            generation_model: null,
            review_model: null,
            prompt_version: null,
            generation_prompt_version: null,
            review_prompt_version: null,
            generation_models: [],
            review_models: [],
            generation_prompt_versions: [],
            review_prompt_versions: [],
            ai_generated_foods: 0,
            reviewed_foods: 0,
        });
    });

    it('never restates the coverage plan, whose model blocks are configuration objects', async () => {
        const files = new Map<string, string>();
        // Proof the plan really does hold objects: this is what used to be
        // assigned into a field typed `string | null`.
        expect(typeof coveragePlan.generationModel).toBe('object');
        expect(typeof coveragePlan.reviewModel).toBe('object');

        await runRelease(exportDeps(fakeDb([publishedFood()], readyLedger()), files));

        const serialised = JSON.stringify(writtenManifest(files).model_versions);
        expect(serialised).not.toContain('envVar');
        expect(serialised).not.toContain(coveragePlan.promptVersion);
        expect(serialised).not.toContain(coveragePlan.reviewPromptVersion);
    });

    it('names one model and prompt when the rows carry exactly one', async () => {
        const files = new Map<string, string>();

        await runRelease(exportDeps(fakeDb([aiFood()], readyLedger()), files));

        expect(writtenManifest(files).model_versions).toMatchObject({
            generation_model: 'google/gemini-2.5-flash',
            generation_models: ['google/gemini-2.5-flash'],
            prompt_version: 'catalog-generation-2026-09-08',
            generation_prompt_version: 'catalog-generation-2026-09-08',
            generation_prompt_versions: ['catalog-generation-2026-09-08'],
            ai_generated_foods: 1,
        });
    });

    it('states the complete set and no single value when a release spans two models', async () => {
        const files = new Map<string, string>();
        const second = aiFood({
            source_key: 'ai:sweet:date bar:prepared',
            catalog_generation_batches: {
                batch_key: 'v1:sweet:0001',
                model: 'anthropic/claude-3-5-sonnet',
                prompt_version: 'catalog-generation-2026-10-01',
            },
        });

        await runRelease(exportDeps(fakeDb([aiFood(), second], readyLedger()), files));

        expect(writtenManifest(files).model_versions).toMatchObject({
            // Collapsing these to "the greatest" attributed every row in the
            // release to one model some of them did not come from.
            generation_model: null,
            generation_models: ['anthropic/claude-3-5-sonnet', 'google/gemini-2.5-flash'],
            prompt_version: null,
            generation_prompt_versions: ['catalog-generation-2026-09-08', 'catalog-generation-2026-10-01'],
            ai_generated_foods: 2,
        });
    });

    it('measures review provenance from llm_review records, including one that failed', async () => {
        const files = new Map<string, string>();
        const reviewed = aiFood({
            catalog_validation_records: validationRecord({
                llm_review: {
                    advisory: true,
                    model: 'openai/gpt-4o-mini',
                    prompt_version: 'catalog-review-2026-09-08',
                    confirmed_checks: [],
                    outcome: 'failed',
                },
            }),
        });

        await runRelease(exportDeps(fakeDb([reviewed], readyLedger()), files));

        expect(writtenManifest(files).model_versions).toMatchObject({
            review_model: 'openai/gpt-4o-mini',
            review_models: ['openai/gpt-4o-mini'],
            review_prompt_version: 'catalog-review-2026-09-08',
            review_prompt_versions: ['catalog-review-2026-09-08'],
            reviewed_foods: 1,
        });
    });

    it('counts a review record that names no model without inventing one', async () => {
        const files = new Map<string, string>();
        const reviewed = aiFood({
            catalog_validation_records: validationRecord({ llm_review: { advisory: true } }),
        });

        await runRelease(exportDeps(fakeDb([reviewed], readyLedger()), files));

        expect(writtenManifest(files).model_versions).toMatchObject({
            review_model: null,
            review_models: [],
            review_prompt_version: null,
            reviewed_foods: 1,
        });
    });

    it('refuses a published AI-generated food it cannot attribute to a batch', async () => {
        const files = new Map<string, string>();
        const unattributable = aiFood({ catalog_generation_batches: null });

        await expect(runRelease(exportDeps(fakeDb([unattributable], readyLedger()), files))).rejects.toThrow(
            'carry no generation batch',
        );
    });

    it('logs the complete measured sets, so a multi-model release says so in the run output', async () => {
        const files = new Map<string, string>();
        const recorder = recordingLogger();
        const second = aiFood({
            source_key: 'ai:sweet:date bar:prepared',
            catalog_generation_batches: {
                batch_key: 'v1:sweet:0001',
                model: 'anthropic/claude-3-5-sonnet',
                prompt_version: 'catalog-generation-2026-09-08',
            },
        });

        await runRelease(
            exportDeps(fakeDb([aiFood(), second], readyLedger()), files, { logger: recorder.logger }),
        );

        const measured = recorder.lines.find((line) => line.event === 'release_model_provenance_measured');
        expect(measured).toBeDefined();
        expect(measured?.fields).toMatchObject({
            generationModels: 'anthropic/claude-3-5-sonnet, google/gemini-2.5-flash',
            aiGeneratedFoods: 2,
        });
    });
});

/**
 * THE ACCEPTANCE VERDICT (F05).
 *
 * The exporter does not refuse a release that misses the catalog requirement —
 * AAP §0.7.5 puts that decision at enablement, and a release that cannot be cut
 * cannot be reviewed, loaded or benchmarked, which is how the evidence floor
 * above gets verified at all. What it must do instead is SAY SO, in the file
 * whose digests travel with the bytes, so that nobody reads a loadable release
 * as evidence the requirement is met.
 *
 * The verdict is two independent conditions, and the pure function is tested
 * across all four of their combinations — which is the whole reason it is pure,
 * because the "aggregate met" half would otherwise need an export of ten
 * thousand rows. The wiring is proved once, against the real coverage plan,
 * where it also pins the production threshold.
 */
describe('the manifest states whether the release meets the catalog requirement (F05)', () => {
    const acceptanceOf = (files: Map<string, string>): ReleaseAcceptanceVerdict =>
        (writtenManifest(files) as CatalogReleaseManifestWithEvidence).acceptance;

    it('says unmet, with the production requirement and the measured gap, for a short release', async () => {
        const files = new Map<string, string>();

        await runRelease(exportDeps(fakeDb([publishedFood()], readyLedger()), files));

        const acceptance = acceptanceOf(files);
        expect(acceptance).toMatchObject({
            requirement_met: false,
            // Pins the threshold this stage measures against WITHOUT injecting
            // it: the number is the requirement, not a test parameter, and
            // `validation-report.json` records the same one as
            // `requirement.requiredPublishedItems`.
            required_published_items: 10000,
            published_items: 1,
            shortfall_against_requirement: 9999,
        });
        // One carrot against a plan that declares every category, so every
        // category is short — read from the plan rather than written as 21, so
        // the assertion survives a plan that gains a category.
        expect(acceptance.categories_below_target).toBe(coveragePlan.categories.length);
        expect(acceptance.per_category_shortfall_total).toBe(coveragePlan.publishedTargetTotal - 1);
        expect(acceptance.statement).toContain('DOES NOT MEET THE CATALOG REQUIREMENT');
        expect(acceptance.statement).toContain('must not be enabled against it');
    });

    it('agrees with the coverage block it sits beside', async () => {
        const files = new Map<string, string>();

        await runRelease(exportDeps(fakeDb([publishedFood()], readyLedger()), files));

        const manifest = writtenManifest(files) as CatalogReleaseManifestWithEvidence;
        // The verdict is derived from the same measurement the coverage block
        // publishes, so a reader who recomputes it has to reach the same
        // answer. That is what makes stating it a convenience rather than a
        // second, drifting source of truth.
        expect(manifest.acceptance.published_items).toBe(manifest.counts.published_foods);
        expect(manifest.acceptance.per_category_shortfall_total).toBe(manifest.coverage.shortfall_total);
        // Read through `categories`, which the manifest type makes mandatory;
        // `by_category` is the same array under the release format's own name
        // and is asserted to be that same array rather than re-counted.
        expect(manifest.acceptance.categories_below_target).toBe(
            manifest.coverage.categories.filter((category) => category.shortfall > 0).length,
        );
        expect(manifest.coverage.by_category).toEqual(manifest.coverage.categories);
    });

    describe('releaseAcceptanceVerdict', () => {
        const at = (publishedItems: number, categoriesBelowTarget: number, perCategoryShortfallTotal: number) =>
            releaseAcceptanceVerdict({
                publishedItems,
                categoryCount: 21,
                categoriesBelowTarget,
                perCategoryShortfallTotal,
            });

        it('is met only when the aggregate is reached and no category is short', () => {
            const verdict = at(10000, 0, 0);

            expect(verdict).toMatchObject({
                requirement_met: true,
                shortfall_against_requirement: 0,
                categories_below_target: 0,
            });
            expect(verdict.statement).toContain('all 21 categories');
            expect(verdict.statement).not.toContain('DOES NOT MEET');
        });

        it('is unmet when a category is short even though the aggregate is reached', () => {
            // The condition that makes this an AND: 11,010 published rows can
            // satisfy a 10,000-item requirement while one category sits below
            // its own target, and a surplus somewhere else is not a substitute
            // for it.
            const verdict = at(11010, 1, 42);

            expect(verdict.requirement_met).toBe(false);
            expect(verdict.shortfall_against_requirement).toBe(0);
            expect(verdict.statement).toContain('DOES NOT MEET THE CATALOG REQUIREMENT');
            expect(verdict.statement).toContain('1 of 21 categories');
        });

        it('is unmet when the aggregate is short even though every category is complete', () => {
            // The other direction, which a plan whose targets sum below the
            // requirement can produce: nothing is short per category, and the
            // catalogue is still 1,000 items below what is required of it.
            const verdict = at(9000, 0, 0);

            expect(verdict.requirement_met).toBe(false);
            expect(verdict.shortfall_against_requirement).toBe(1000);
            expect(verdict.categories_below_target).toBe(0);
            expect(verdict.statement).toContain('9000 items against the required 10000');
        });

        it('is unmet on both counts, and reports each gap under its own name', () => {
            const verdict = at(9422, 13, 2392);

            expect(verdict).toMatchObject({
                requirement_met: false,
                published_items: 9422,
                shortfall_against_requirement: 578,
                categories_below_target: 13,
                per_category_shortfall_total: 2392,
            });
            // The aggregate gap and the per-category gap are different
            // measurements of different things, and neither is the other's
            // total — 578 is what the catalogue owes the requirement, 2,392 is
            // what thirteen categories owe their own targets.
            expect(verdict.shortfall_against_requirement).not.toBe(verdict.per_category_shortfall_total);
        });

        it('never reports a negative shortfall for a release that overshoots', () => {
            expect(at(12000, 0, 0).shortfall_against_requirement).toBe(0);
        });
    });
});

describe('the coverage plan declares model CONFIGURATION, and it is checked', () => {
    const plan = (overrides: Record<string, unknown>): unknown => ({
        coveragePlanVersion: 'v1',
        promptVersion: 'catalog-generation-2026-09-08',
        reviewPromptVersion: 'catalog-review-2026-09-08',
        generationModel: { envVar: 'CATALOG_GENERATION_MODEL', fallbackModel: 'google/gemini-2.5-flash' },
        reviewModel: { envVar: 'CATALOG_REVIEW_MODEL', fallbackModel: 'openai/gpt-4o-mini' },
        ...overrides,
    });

    it('accepts the committed document', () => {
        expect(() => assertCoveragePlanModelShape(plan({}), 'coverage-plan.v1.json')).not.toThrow();
        // And the real one, through its loader.
        expect(() => loadCoveragePlan()).not.toThrow();
    });

    it('accepts a plan that leaves a stage to the environment entirely', () => {
        expect(() =>
            assertCoveragePlanModelShape(
                plan({ generationModel: undefined, reviewModel: undefined }),
                'coverage-plan.v1.json',
            ),
        ).not.toThrow();
    });

    it('refuses the string the type used to claim, which is what hid the mismatch', () => {
        expect(() =>
            assertCoveragePlanModelShape(plan({ generationModel: 'google/gemini-2.5-flash' }), 'coverage-plan.v1.json'),
        ).toThrow(ManifestError);
    });

    it.each<[string, Record<string, unknown>]>([
        ['generationModel.envVar', { generationModel: { fallbackModel: 'x' } }],
        ['generationModel.fallbackModel', { generationModel: { envVar: 'X' } }],
        ['reviewModel.fallbackEnvVar', { reviewModel: { envVar: 'X', fallbackModel: 'y', fallbackEnvVar: 7 } }],
        ['promptVersion', { promptVersion: 42 }],
        ['reviewPromptVersion', { reviewPromptVersion: '' }],
    ])('refuses a document whose %s is not what the type promises', (_field, overrides) => {
        expect(() => assertCoveragePlanModelShape(plan(overrides), 'coverage-plan.v1.json')).toThrow(ManifestError);
    });
});

/**
 * The identity of a directory the fake filesystem holds, as the run that
 * created it would have captured it.
 *
 * A thrown error rather than a fabricated pair when the path names no
 * directory: a publication input carrying an invented identity would prove
 * nothing about the check that compares it.
 */
const identityOf = (system: FakeFileSystem, directory: string): ReleaseDirectoryIdentity => {
    const identity = system.directoryIdentity(directory);
    if (identity === null) {
        throw new Error(`${directory} is not a directory in this fake filesystem`);
    }
    return identity;
};

describe('publication enforces --force and serialises by final path', () => {
    const publishInput = (system: FakeFileSystem, force: boolean): PublishReleaseInput => ({
        stagingDirectory: STAGING_DIRECTORY,
        stagingIdentity: identityOf(system, STAGING_DIRECTORY),
        finalDirectory: FINAL_DIRECTORY,
        force,
        pid: PID,
        now: () => NOW,
        fileSystem: system,
        logger: silentLogger,
    });

    it('moves staging into place in one rename when nothing is there', () => {
        const system = fakeFileSystem();
        system.ensureDir(STAGING_DIRECTORY);

        publishRelease(publishInput(system, false));

        // The safe-parent assertion comes FIRST, before the lock file is
        // created in that parent and before anything is moved into it.
        expect(system.actions).toEqual([
            `safeParent:${FINAL_DIRECTORY}`,
            `lock:${publicationLockFor(FINAL_DIRECTORY)}`,
            `rename:${STAGING_DIRECTORY}->${FINAL_DIRECTORY}`,
            `unlock:${publicationLockFor(FINAL_DIRECTORY)}`,
        ]);
        expect(system.directoryExists(FINAL_DIRECTORY)).toBe(true);
    });

    it('refuses a destination that appeared after preflight, rather than replacing it', () => {
        const system = fakeFileSystem();
        system.ensureDir(STAGING_DIRECTORY);
        // Published by the other run between this run's preflight and now.
        system.ensureDir(FINAL_DIRECTORY);

        expect(() => publishRelease(publishInput(system, false))).toThrow(ReleasePublicationError);
        try {
            publishRelease(publishInput(system, false));
            throw new Error('expected a refusal');
        } catch (error) {
            expect((error as ReleasePublicationError).code).toBe('release_directory_exists');
            expect((error as Error).message).toContain('--force');
        }
        // The reviewed release is untouched and the lock is not left behind.
        expect(system.actions.filter((action) => action.startsWith('rename:'))).toEqual([]);
        expect(system.locks.size).toBe(0);
    });

    it('replaces a destination only with --force, and only after moving the old one aside', () => {
        const system = fakeFileSystem();
        system.ensureDir(STAGING_DIRECTORY);
        system.ensureDir(FINAL_DIRECTORY);

        publishRelease(publishInput(system, true));

        const superseded = path.join(path.dirname(FINAL_DIRECTORY), `.${path.basename(FINAL_DIRECTORY)}.superseded-${PID}`);
        expect(system.actions).toEqual([
            `safeParent:${FINAL_DIRECTORY}`,
            `lock:${publicationLockFor(FINAL_DIRECTORY)}`,
            `removeDir:${superseded}`,
            `rename:${FINAL_DIRECTORY}->${superseded}`,
            `rename:${STAGING_DIRECTORY}->${FINAL_DIRECTORY}`,
            `removeDir:${superseded}`,
            `unlock:${publicationLockFor(FINAL_DIRECTORY)}`,
        ]);
    });

    it('puts the old release back when the new one cannot take the path', () => {
        const system = fakeFileSystem();
        system.ensureDir(STAGING_DIRECTORY);
        system.ensureDir(FINAL_DIRECTORY);
        // Only the NEW release's move fails; the rollback's own move must work.
        system.failRename = `${STAGING_DIRECTORY}->${FINAL_DIRECTORY}`;

        expect(() => publishRelease(publishInput(system, true))).toThrow('refused');
        // The last rename put the reviewed release back where it was.
        expect(system.directoryExists(FINAL_DIRECTORY)).toBe(true);
        expect(system.locks.size).toBe(0);
    });

    it('refuses while another publication holds the final path, touching nothing', () => {
        const system = fakeFileSystem();
        system.ensureDir(STAGING_DIRECTORY);
        system.lockHeldByAnother = true;

        try {
            publishRelease(publishInput(system, true));
            throw new Error('expected a refusal');
        } catch (error) {
            expect((error as ReleasePublicationError).code).toBe('release_publication_locked');
        }
        expect(system.actions.filter((action) => action.startsWith('rename:'))).toEqual([]);
    });

    it('takes the lock atomically on a real filesystem, so two runs cannot both hold it', () => {
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'soh-release-lock-'));
        const lockPath = path.join(directory, '.v99.publish.lock');
        try {
            expect(nodeReleaseFileSystem.createFileExclusive(lockPath, 'first\n')).toBe(true);
            expect(nodeReleaseFileSystem.createFileExclusive(lockPath, 'second\n')).toBe(false);
            // The holder's stamp is intact: the loser wrote nothing.
            expect(fs.readFileSync(lockPath, 'utf-8')).toBe('first\n');
            nodeReleaseFileSystem.removeFile(lockPath);
            expect(nodeReleaseFileSystem.createFileExclusive(lockPath, 'third\n')).toBe(true);
        } finally {
            fs.rmSync(directory, { recursive: true, force: true });
        }
    });
});

// ---------------------------------------------------------------------------

/**
 * A real temporary tree for the cases that must exercise the NODE filesystem
 * members rather than the in-memory double.
 *
 * An in-memory double cannot refuse a symbolic link it was never asked to
 * model, so every claim about what an open or an mkdir does when another
 * principal has pre-placed a name is made against the kernel here. The
 * directory `mkdtemp` creates is mode 0700, which is what
 * `assertSafeArtifactParent` requires of a parent — so a case that wants a
 * HOSTILE parent has to widen the mode itself, and says so where it does.
 */
const realTree = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'soh-release-staging-'));

describe('the staging directory is created, never adopted, and its identity is verified through publication (F05)', () => {
    it('names its staging directory unguessably, from the CSPRNG rather than from the pid', () => {
        const first = stagingDirFor(FINAL_DIRECTORY, PID);
        const second = stagingDirFor(FINAL_DIRECTORY, PID);

        // Same release, same pid, different directory: the name is not a
        // function of what another local principal can observe about this run.
        expect(first).not.toBe(second);

        const prefix = path.join(path.dirname(FINAL_DIRECTORY), `${stagingPrefixFor(FINAL_DIRECTORY)}${PID}-`);
        expect(first.startsWith(prefix)).toBe(true);
        expect(second.startsWith(prefix)).toBe(true);
        expect(first.slice(prefix.length)).toMatch(/^[0-9a-f]{16}$/);
        expect(second.slice(prefix.length)).toMatch(/^[0-9a-f]{16}$/);

        // An injected component is used exactly as given, which is the only way
        // a caller ever knows the path it is about to write into.
        expect(stagingDirFor(FINAL_DIRECTORY, PID, STAGING_SUFFIX)).toBe(`${prefix}${STAGING_SUFFIX}`);
    });

    it('refuses a staging name pre-placed as a symbolic link, writing nothing through it', () => {
        const root = realTree();
        try {
            const parent = path.join(root, 'releases');
            fs.mkdirSync(parent, { mode: 0o700 });
            const elsewhere = path.join(root, 'elsewhere');
            fs.mkdirSync(elsewhere, { mode: 0o700 });
            fs.writeFileSync(path.join(elsewhere, 'foods.jsonl'), 'untouched\n', 'utf-8');

            const finalDirectory = path.join(parent, RELEASE);
            const staging = stagingDirFor(finalDirectory, PID, STAGING_SUFFIX);
            // The attack: the name this run would use, pre-placed as a link to
            // a tree the attacker controls.
            fs.symlinkSync(elsewhere, staging, 'dir');

            try {
                nodeReleaseFileSystem.createDirectoryExclusive(staging);
                throw new Error('expected a refusal');
            } catch (error) {
                expect(error).toBeInstanceOf(ManifestError);
                expect((error as ManifestError).code).toBe('unsafe_artifact_directory');
            }

            // The link is untouched — it was neither followed nor repaired —
            // and so is everything it points at.
            expect(fs.lstatSync(staging).isSymbolicLink()).toBe(true);
            expect(fs.readdirSync(elsewhere)).toEqual(['foods.jsonl']);
            expect(fs.readFileSync(path.join(elsewhere, 'foods.jsonl'), 'utf-8')).toBe('untouched\n');
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });

    it('refuses a member write at a name pre-placed as a symbolic link', () => {
        const root = realTree();
        try {
            const staging = path.join(root, 'staging');
            fs.mkdirSync(staging, { mode: 0o700 });
            const memberTarget = path.join(root, 'member-target.jsonl');
            const manifestTarget = path.join(root, 'manifest-target.json');
            fs.writeFileSync(memberTarget, 'untouched\n', 'utf-8');
            fs.writeFileSync(manifestTarget, 'untouched\n', 'utf-8');
            fs.symlinkSync(memberTarget, path.join(staging, 'foods.jsonl'));
            fs.symlinkSync(manifestTarget, path.join(staging, RELEASE_MANIFEST_FILE_NAME));

            const openWriter = nodeReleaseFileSystem.openWriter;
            if (openWriter === undefined) {
                throw new Error('the node filesystem must supply a descriptor writer');
            }

            // Both write paths: the five members go through `openWriter`, the
            // manifest through `writeFile`, and a link at either name is a
            // refusal rather than a write into whatever it points at.
            try {
                openWriter(path.join(staging, 'foods.jsonl'));
                throw new Error('expected a refusal');
            } catch (error) {
                expect((error as NodeJS.ErrnoException).code).toMatch(/^(EEXIST|ELOOP)$/);
            }
            try {
                nodeReleaseFileSystem.writeFile(path.join(staging, RELEASE_MANIFEST_FILE_NAME), '{}\n');
                throw new Error('expected a refusal');
            } catch (error) {
                expect((error as NodeJS.ErrnoException).code).toMatch(/^(EEXIST|ELOOP)$/);
            }

            expect(fs.readFileSync(memberTarget, 'utf-8')).toBe('untouched\n');
            expect(fs.readFileSync(manifestTarget, 'utf-8')).toBe('untouched\n');
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });

    it('sweeps a real orphan staging directory and leaves a symbolic link bearing a staging name alone', () => {
        const root = realTree();
        try {
            const parent = path.join(root, 'releases');
            fs.mkdirSync(parent, { mode: 0o700 });
            const finalDirectory = path.join(parent, RELEASE);
            fs.mkdirSync(finalDirectory, { mode: 0o700 });
            const lockPath = publicationLockFor(finalDirectory);
            fs.writeFileSync(lockPath, 'held\n', 'utf-8');

            const orphan = stagingDirFor(finalDirectory, 999, 'a'.repeat(16));
            fs.mkdirSync(orphan, { mode: 0o700 });
            fs.writeFileSync(path.join(orphan, 'foods.jsonl'), 'half a release\n', 'utf-8');

            const linkTarget = path.join(root, 'elsewhere');
            fs.mkdirSync(linkTarget, { mode: 0o700 });
            fs.writeFileSync(path.join(linkTarget, 'keep.txt'), 'untouched\n', 'utf-8');
            const link = stagingDirFor(finalDirectory, 998, 'b'.repeat(16));
            fs.symlinkSync(linkTarget, link, 'dir');

            const removed = sweepOrphanStagingDirectories({
                finalDirectory,
                keep: stagingDirFor(finalDirectory, PID, STAGING_SUFFIX),
                fileSystem: nodeReleaseFileSystem,
                pidIsRunning: () => false,
                logger: silentLogger,
            });

            expect(removed).toEqual([orphan]);
            expect(fs.existsSync(orphan)).toBe(false);
            // The link is left where it is: following it would delete a tree
            // somewhere else, and removing it would hide it from the operator.
            expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
            expect(fs.readdirSync(linkTarget)).toEqual(['keep.txt']);
            // Neither the release nor the publication lock is a candidate.
            expect(fs.existsSync(finalDirectory)).toBe(true);
            expect(fs.existsSync(lockPath)).toBe(true);
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });

    it('leaves a staging directory alone while a process with its pid is running', () => {
        const root = realTree();
        try {
            const parent = path.join(root, 'releases');
            fs.mkdirSync(parent, { mode: 0o700 });
            const finalDirectory = path.join(parent, RELEASE);
            // This process is live by definition, so the kernel's own answer —
            // no `pidIsRunning` override here — is what retains this directory.
            const live = stagingDirFor(finalDirectory, process.pid, 'c'.repeat(16));
            fs.mkdirSync(live, { mode: 0o700, recursive: true });

            const removed = sweepOrphanStagingDirectories({
                finalDirectory,
                keep: stagingDirFor(finalDirectory, PID, STAGING_SUFFIX),
                fileSystem: nodeReleaseFileSystem,
                logger: silentLogger,
            });

            expect(removed).toEqual([]);
            expect(fs.existsSync(live)).toBe(true);
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });

    describe('pidIsRunning', () => {
        it('reports this process as running', () => {
            expect(pidIsRunning(process.pid)).toBe(true);
        });

        it.each([0, -1, -4242, 1.5, Number.NaN])('answers running for %p without signalling anything', (pid) => {
            // 0 and negatives address process GROUPS, so the only safe answer
            // is the one that asks the kernel nothing and sweeps nothing.
            expect(pidIsRunning(pid)).toBe(true);
        });
    });

    describe('orphanStagingPid', () => {
        it.each<[string, number]>([
            [`${stagingPrefixFor(FINAL_DIRECTORY)}${PID}-${STAGING_SUFFIX}`, PID],
            [`${stagingPrefixFor(FINAL_DIRECTORY)}17`, 17],
        ])('reads the pid out of %s', (entryName, pid) => {
            expect(orphanStagingPid(entryName, FINAL_DIRECTORY)).toBe(pid);
        });

        it.each<[string, string]>([
            ['the release directory itself', path.basename(FINAL_DIRECTORY)],
            ['the publication lock', path.basename(publicationLockFor(FINAL_DIRECTORY))],
            ['a superseded release', `.${path.basename(FINAL_DIRECTORY)}.superseded-${PID}`],
            ['another release id', `.v100.staging-${PID}-${STAGING_SUFFIX}`],
            ['a nonce that is not 16 hex characters', `.${path.basename(FINAL_DIRECTORY)}.staging-${PID}-abc`],
            ['a nonce with a non-hex character', `.${path.basename(FINAL_DIRECTORY)}.staging-${PID}-g1b2c3d4e5f60789`],
            ['a pid that is not digits', `.${path.basename(FINAL_DIRECTORY)}.staging-abc-${STAGING_SUFFIX}`],
            ['a third segment', `.${path.basename(FINAL_DIRECTORY)}.staging-${PID}-${STAGING_SUFFIX}-1`],
            ['a pid of zero, which addresses a process group', `.${path.basename(FINAL_DIRECTORY)}.staging-0-${STAGING_SUFFIX}`],
        ])('refuses to read %s as a staging directory', (_case, entryName) => {
            expect(orphanStagingPid(entryName, FINAL_DIRECTORY)).toBeNull();
        });
    });

    it('refuses to publish when the staging directory is no longer the one that was exported', () => {
        const system = fakeFileSystem();
        system.ensureDir(STAGING_DIRECTORY);
        const exported = identityOf(system, STAGING_DIRECTORY);
        // Replaced under the run: the same name, a different directory — which
        // a comparison of path strings cannot tell apart.
        system.removeDir(STAGING_DIRECTORY);
        system.ensureDir(STAGING_DIRECTORY);
        expect(identityOf(system, STAGING_DIRECTORY)).not.toEqual(exported);

        try {
            publishRelease({
                stagingDirectory: STAGING_DIRECTORY,
                stagingIdentity: exported,
                finalDirectory: FINAL_DIRECTORY,
                force: false,
                pid: PID,
                now: () => NOW,
                fileSystem: system,
                logger: silentLogger,
            });
            throw new Error('expected a refusal');
        } catch (error) {
            expect((error as ReleasePublicationError).code).toBe('release_staging_identity_changed');
        }

        // Nothing was moved and the lock was released.
        expect(system.actions.filter((action) => action.startsWith('rename:'))).toEqual([]);
        expect(system.locks.size).toBe(0);
        expect(system.directoryExists(FINAL_DIRECTORY)).toBe(false);
    });

    it('puts the reviewed release back when the staging identity changed on the --force path', () => {
        const system = fakeFileSystem();
        system.ensureDir(STAGING_DIRECTORY);
        const exported = identityOf(system, STAGING_DIRECTORY);
        system.ensureDir(FINAL_DIRECTORY);
        system.removeDir(STAGING_DIRECTORY);
        system.ensureDir(STAGING_DIRECTORY);

        try {
            publishRelease({
                stagingDirectory: STAGING_DIRECTORY,
                stagingIdentity: exported,
                finalDirectory: FINAL_DIRECTORY,
                force: true,
                pid: PID,
                now: () => NOW,
                fileSystem: system,
                logger: silentLogger,
            });
            throw new Error('expected a refusal');
        } catch (error) {
            expect((error as ReleasePublicationError).code).toBe('release_staging_identity_changed');
        }

        // The reviewed release was moved aside and put back, never deleted.
        expect(system.directoryExists(FINAL_DIRECTORY)).toBe(true);
        expect(system.locks.size).toBe(0);
    });

    it('refuses to publish into a parent other local principals can write, before taking the lock', () => {
        const root = realTree();
        try {
            const parent = path.join(root, 'releases');
            fs.mkdirSync(parent);
            // World-writable and NOT sticky: another local principal can create
            // the publication lock, or move the reviewed release aside, in this
            // directory. `/tmp` is the same mode with the sticky bit set, which
            // is why the bit and not the write bits is what decides.
            fs.chmodSync(parent, 0o777);

            const finalDirectory = path.join(parent, RELEASE);
            const staging = stagingDirFor(finalDirectory, PID, STAGING_SUFFIX);
            fs.mkdirSync(staging, { mode: 0o700 });
            const identity = nodeReleaseFileSystem.directoryIdentity(staging);
            if (identity === null) {
                throw new Error(`${staging} was created and does not read back as a directory`);
            }

            try {
                publishRelease({
                    stagingDirectory: staging,
                    stagingIdentity: identity,
                    finalDirectory,
                    force: false,
                    pid: PID,
                    now: () => NOW,
                    fileSystem: nodeReleaseFileSystem,
                    logger: silentLogger,
                });
                throw new Error('expected a refusal');
            } catch (error) {
                expect(error).toBeInstanceOf(ManifestError);
                expect((error as ManifestError).code).toBe('unsafe_artifact_directory');
            }

            // No lock file was created and nothing was published: the staging
            // directory is all that is there.
            expect(fs.readdirSync(parent)).toEqual([path.basename(staging)]);
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });

    it('refuses to stage into a real parent other local principals can write', async () => {
        const root = realTree();
        try {
            const parent = path.join(root, 'releases');
            fs.mkdirSync(parent);
            // World-writable and not sticky: another principal could pre-place
            // the staging name here, so this run declines to stage in it at all
            // rather than racing them for the name.
            fs.chmodSync(parent, 0o777);
            const finalDirectory = path.join(parent, RELEASE);
            const db = fakeDb([publishedFood()], readyLedger());

            await expect(
                runReleaseStage({
                    db,
                    coveragePlan,
                    release: RELEASE,
                    force: false,
                    finalDirectory,
                    logger: silentLogger,
                    now: () => NOW,
                    pid: PID,
                    fileSystem: nodeReleaseFileSystem,
                    stagingSuffix: STAGING_SUFFIX,
                    pidIsRunning: () => false,
                }),
            ).rejects.toThrow(ManifestError);

            // Nothing was created and no ledger row was opened: the refusal is
            // ahead of both.
            expect(fs.readdirSync(parent)).toEqual([]);
            expect(db.created).toEqual([]);
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });

    it('exports and publishes on a real filesystem, and the manifest describes the published bytes', async () => {
        const root = realTree();
        try {
            const parent = path.join(root, 'releases');
            fs.mkdirSync(parent, { mode: 0o700 });
            const finalDirectory = path.join(parent, RELEASE);
            const db = fakeDb([publishedFood()], readyLedger());

            const outcome = await runReleaseStage({
                db,
                coveragePlan,
                release: RELEASE,
                force: false,
                finalDirectory,
                logger: silentLogger,
                now: () => NOW,
                pid: PID,
                fileSystem: nodeReleaseFileSystem,
                stagingSuffix: STAGING_SUFFIX,
                pidIsRunning: () => false,
            });

            expect(outcome.publishedFoods).toBe(1);
            for (const member of [...RELEASE_DATA_FILES, RELEASE_MANIFEST_FILE_NAME]) {
                expect(fs.existsSync(path.join(finalDirectory, member))).toBe(true);
            }
            // The staging directory became the release; nothing is left beside
            // it, lock file included.
            expect(fs.readdirSync(parent)).toEqual([RELEASE]);

            // Exclusive, no-follow writes produce the same measured release:
            // every digest and size in the manifest describes the bytes now at
            // the reviewed path.
            const manifest = JSON.parse(
                fs.readFileSync(path.join(finalDirectory, RELEASE_MANIFEST_FILE_NAME), 'utf-8'),
            ) as CatalogReleaseManifest;
            expect(manifest.files).toHaveLength(RELEASE_DATA_FILES.length);
            for (const file of manifest.files) {
                // `path`, the member name every reader of a release has: `name`
                // is the same string under the format contract's spelling and
                // is optional in the type.
                const bytes = fs.readFileSync(path.join(finalDirectory, file.path));
                expect(crypto.createHash('sha256').update(bytes).digest('hex')).toBe(file.sha256);
                expect(bytes.length).toBe(file.bytes);
            }
            expect(db.updated[0].data).toMatchObject({ status: 'succeeded' });
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });

    /**
     * THE WINDOW BETWEEN IDENTITY CAPTURE AND THE FIRST MEMBER OPEN.
     *
     * The two cases above cover a staging name pre-placed as a link (refused by
     * the exclusive create) and a replacement noticed at publication (refused
     * by the rename's identity check). Neither reaches the case in between: the
     * directory is created and identified, and only THEN does the stage await
     * the ledger row and the export's snapshot. Every member is opened by
     * PATHNAME on the far side of those awaits, and `O_NOFOLLOW` settles a
     * member's own last component only — so a staging directory swapped for a
     * link inside that window sends every member, manifest included, wherever
     * the link points, and publication's refusal afterwards arrives after the
     * bytes have left the process.
     *
     * Driven on the real filesystem with the real export, because the claim is
     * about what the kernel does with `path.join(link, 'foods.jsonl')` and no
     * in-memory double can make it.
     */
    it('refuses when the staging directory is replaced while the ledger row is awaited, and no member reaches the decoy', async () => {
        const root = realTree();
        try {
            const parent = path.join(root, 'releases');
            fs.mkdirSync(parent, { mode: 0o700 });

            // A reviewed release already at the path, so this case also states
            // what a refused run does to the release it would have replaced.
            const finalDirectory = path.join(parent, RELEASE);
            fs.mkdirSync(finalDirectory, { mode: 0o700 });
            const published = path.join(finalDirectory, RELEASE_MANIFEST_FILE_NAME);
            fs.writeFileSync(published, 'the reviewed release\n', 'utf-8');

            // Where the attacker wants the six members to land.
            const decoy = path.join(root, 'decoy');
            fs.mkdirSync(decoy, { mode: 0o700 });

            const staging = stagingDirFor(finalDirectory, PID, STAGING_SUFFIX);
            const db = fakeDb([publishedFood()], readyLedger());

            // THE SEAM: the ledger row is the first await after the staging
            // directory is created and its identity captured, and every member
            // open is on the far side of it. The suite mutates state inside an
            // awaited call here for the same reason it does elsewhere — it is
            // the only way to be inside the window rather than before or after
            // it.
            const openLedgerRow = db.catalog_import_runs.create;
            db.catalog_import_runs.create = async (args: unknown): Promise<{ id: string }> => {
                // `rmSync` of a real directory, then the link in its place:
                // the same name, a different thing at it.
                fs.rmSync(staging, { recursive: true, force: true });
                fs.symlinkSync(decoy, staging, 'dir');
                return openLedgerRow(args);
            };

            try {
                await runReleaseStage({
                    db,
                    coveragePlan,
                    release: RELEASE,
                    force: true,
                    finalDirectory,
                    logger: silentLogger,
                    now: () => NOW,
                    pid: PID,
                    fileSystem: nodeReleaseFileSystem,
                    stagingSuffix: STAGING_SUFFIX,
                    pidIsRunning: () => false,
                });
                throw new Error('expected a refusal');
            } catch (error) {
                expect(error).toBeInstanceOf(ReleasePublicationError);
                expect((error as ReleasePublicationError).code).toBe('release_staging_identity_changed');
            }

            // NOT ONE MEMBER REACHED THE DECOY. This is the assertion the
            // finding is about: the refusal has to come before the writes, not
            // after them.
            expect(fs.readdirSync(decoy)).toEqual([]);

            // The reviewed release is byte-identical, and --force was on the
            // command line: a refused run replaces nothing.
            expect(fs.readdirSync(finalDirectory)).toEqual([RELEASE_MANIFEST_FILE_NAME]);
            expect(fs.readFileSync(published, 'utf-8')).toBe('the reviewed release\n');

            // The link was discarded with the staging directory it stood in
            // for — `rmSync` unlinks it rather than following it — so nothing
            // is left beside the release, lock file included.
            expect(fs.readdirSync(parent)).toEqual([RELEASE]);
            expect(fs.existsSync(decoy)).toBe(true);

            // And the ledger says what happened, with the code that names it.
            expect(db.updated[0].data).toMatchObject({ status: 'failed' });
            expect((db.updated[0].data.log as { code?: string }[])[1].code).toBe(
                'release_staging_identity_changed',
            );
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });

    /**
     * The same attack one step later: after the members are open, while the
     * walk is awaiting a page of rows. The five descriptors are already held,
     * so those writes follow the descriptors and not the pathname — but the
     * read-backs the manifest's digests are measured from, and the manifest
     * write itself, are still path operations, and a manifest written through
     * the replacement would be a complete release document somewhere nobody
     * asked for.
     */
    it('refuses when the staging directory is replaced mid-walk, so no manifest is written through the replacement', async () => {
        const root = realTree();
        try {
            const parent = path.join(root, 'releases');
            fs.mkdirSync(parent, { mode: 0o700 });
            const finalDirectory = path.join(parent, RELEASE);

            // The decoy already holds the five member names, with the
            // attacker's bytes in them. That is what makes this case about the
            // MANIFEST: the read-backs would succeed, measure those bytes, and
            // the manifest written beside them would be a valid release
            // document whose digests verify an artefact set this pipeline never
            // produced.
            const decoy = path.join(root, 'decoy');
            fs.mkdirSync(decoy, { mode: 0o700 });
            for (const member of RELEASE_DATA_FILES) {
                fs.writeFileSync(path.join(decoy, member), 'attacker bytes\n', 'utf-8');
            }

            const staging = stagingDirFor(finalDirectory, PID, STAGING_SUFFIX);
            const db = fakeDb([publishedFood()], readyLedger());

            // The page read is the last await before the read-backs, and the
            // members are open by the time it runs.
            const readPage = db.catalog_foods.findMany;
            db.catalog_foods.findMany = async (args: unknown): Promise<ReleaseFoodRow[]> => {
                const page = await readPage(args);
                fs.rmSync(staging, { recursive: true, force: true });
                if (!fs.existsSync(staging)) {
                    fs.symlinkSync(decoy, staging, 'dir');
                }
                return page;
            };

            try {
                await runReleaseStage({
                    db,
                    coveragePlan,
                    release: RELEASE,
                    force: false,
                    finalDirectory,
                    logger: silentLogger,
                    now: () => NOW,
                    pid: PID,
                    fileSystem: nodeReleaseFileSystem,
                    stagingSuffix: STAGING_SUFFIX,
                    pidIsRunning: () => false,
                });
                throw new Error('expected a refusal');
            } catch (error) {
                expect((error as ReleasePublicationError).code).toBe('release_staging_identity_changed');
            }

            // NO MANIFEST WAS WRITTEN INTO THE DECOY, and the attacker's bytes
            // are exactly as they were: an artefact set is only a release once
            // the manifest describes it, so the file that is absent here is the
            // one that would have turned five planted files into a release.
            expect(fs.readdirSync(decoy).sort()).toEqual([...RELEASE_DATA_FILES].sort());
            for (const member of RELEASE_DATA_FILES) {
                expect(fs.readFileSync(path.join(decoy, member), 'utf-8')).toBe('attacker bytes\n');
            }
            expect(fs.existsSync(finalDirectory)).toBe(false);
            expect(fs.readdirSync(parent)).toEqual([]);
            expect(db.updated[0].data).toMatchObject({ status: 'failed' });
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });

    it('re-establishes the staging identity immediately before every member open, read-back and manifest write', async () => {
        const files = new Map<string, string>();
        // One log for the checks and the path operations together, so "before
        // every one of them" is a statement about ordering and not a count.
        const order: string[] = [];
        const db = fakeDb([publishedFood()], readyLedger());

        await runRelease(
            exportDeps(db, files, {
                releaseDir: () => STAGING_DIRECTORY,
                assertReleaseDirectoryUnchanged: () => {
                    order.push('check');
                },
                ensureDir: () => {
                    order.push('ensureDir');
                },
                openWriter: (absolutePath: string) => {
                    order.push(`open:${path.basename(absolutePath)}`);
                    const chunks: string[] = [];
                    return {
                        write: (chunk: string): void => {
                            chunks.push(chunk);
                        },
                        close: (): void => {
                            files.set(absolutePath, chunks.join(''));
                        },
                    };
                },
                readFileBytes: (absolutePath: string) => {
                    order.push(`read:${path.basename(absolutePath)}`);
                    return Buffer.from(files.get(absolutePath) ?? '', 'utf-8');
                },
                writeFile: (absolutePath: string, contents: string) => {
                    order.push(`write:${path.basename(absolutePath)}`);
                    files.set(absolutePath, contents);
                },
            }),
        );

        expect(order).toEqual([
            'check',
            'ensureDir',
            ...RELEASE_DATA_FILES.flatMap((member) => ['check', `open:${member}`]),
            ...RELEASE_DATA_FILES.flatMap((member) => ['check', `read:${member}`]),
            'check',
            `write:${RELEASE_MANIFEST_FILE_NAME}`,
        ]);
        // Nothing touched a path without a preceding check: every odd entry is
        // one, which is the same fact stated so a member added later cannot
        // slip in unguarded.
        expect(order.filter((_entry, index) => index % 2 === 0)).toEqual(order.filter((entry) => entry === 'check'));
    });

    it('resolves a release path through the symbolic links above it, and still refuses a traversing id', () => {
        const root = realTree();
        try {
            const physical = path.join(root, 'physical-releases');
            fs.mkdirSync(physical, { mode: 0o700 });
            // The same releases directory under a second name. Lexically these
            // are two paths; physically they are one place, and a stage that
            // could not tell would apply its parent and identity checks to a
            // chain it had never resolved.
            const alias = path.join(root, 'alias-releases');
            fs.symlinkSync(physical, alias, 'dir');

            expect(resolveReleaseDir(alias)(RELEASE)).toBe(path.join(fs.realpathSync(physical), RELEASE));
            expect(resolveReleaseDir(alias)(RELEASE)).toBe(resolveReleaseDir(physical)(RELEASE));

            // The repository's own tree is resolved the same way: ancestors
            // through `realpath`, the release id appended as the validated
            // segment it is.
            const canonical = releaseDir(RELEASE);
            expect(resolveReleaseDir(null)(RELEASE)).toBe(
                path.join(fs.realpathSync(path.dirname(canonical)), path.basename(canonical)),
            );

            // Resolving ancestors is not a way around containment: the id is
            // still one safe segment in both branches.
            expect(() => resolveReleaseDir(alias)('../escape')).toThrow(ManifestError);
            expect(() => resolveReleaseDir(null)('../escape')).toThrow(ManifestError);
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });
});

describe('the release ledger says succeeded only once the release is at its path', () => {
    const stageDeps = (
        db: FakeDb,
        system: FakeFileSystem,
        overrides: Partial<RunReleaseStageDeps> = {},
    ): RunReleaseStageDeps => ({
        db,
        coveragePlan,
        release: RELEASE,
        force: false,
        finalDirectory: FINAL_DIRECTORY,
        logger: silentLogger,
        now: () => NOW,
        pid: PID,
        fileSystem: system,
        // Fixed so the staging path is the one this suite asserts about, and
        // stated here rather than relied on by default: a run generates it.
        stagingSuffix: STAGING_SUFFIX,
        // No pid is live for these cases, so the orphan sweep's decision is
        // about the ENTRY it found and not about what happens to be running on
        // the machine the suite runs on.
        pidIsRunning: () => false,
        runExport: async (): Promise<ReleaseOutcome> => {
            db.calls.push('export');
            return { release: RELEASE, publishedFoods: 1, counts: { foods: 1 }, shortfallTotal: 0 };
        },
        publish: () => {
            db.calls.push('publish');
        },
        ...overrides,
    });

    it('opens the row running before the export and closes it succeeded after publication', async () => {
        const calls: string[] = [];
        const db = fakeDb([], readyLedger(), calls);
        const system = fakeFileSystem();

        const outcome = await runReleaseStage(stageDeps(db, system));

        expect(outcome.publishedFoods).toBe(1);
        expect(calls).toEqual(['ledger:create', 'export', 'publish', 'ledger:update']);
        expect(db.created[0]).toMatchObject({ kind: 'release', manifest_version: RELEASE, status: 'running', finished_at: null });
        expect(db.updated[0].data).toMatchObject({ status: 'succeeded', counts: { foods: 1 } });
    });

    it('creates its staging directory exclusively before it awaits the ledger', async () => {
        // ONE log for both effects, so the ordering between a filesystem action
        // and a database round trip is assertable. It is the ordering the
        // finding is about: the staging directory used to be removed here and
        // created only after this await, which left an attacker the length of a
        // database round trip to pre-place the name it was about to use.
        const log: string[] = [];
        const db = fakeDb([], readyLedger(), log);
        const system = fakeFileSystem(log);

        await runReleaseStage(stageDeps(db, system));

        // Two parent assertions, and both are meant: the stage states the rule
        // itself before it creates anything, and the exclusive create it then
        // calls holds its own argument to the same rule. The export's guarantee
        // does not rest on a primitive a later refactor could reach past.
        expect(log.slice(0, 4)).toEqual([
            `safeParent:${STAGING_DIRECTORY}`,
            `safeParent:${STAGING_DIRECTORY}`,
            `createDir:${STAGING_DIRECTORY}`,
            'ledger:create',
        ]);
        // Nothing is removed at a guessable name before the create, because
        // the create refuses an existing entry instead of clearing it.
        expect(log.filter((entry) => entry.startsWith('removeDir:'))).toEqual([]);
    });

    it('refuses to stage over an entry already at its staging name, before any ledger row exists', async () => {
        const db = fakeDb([], readyLedger());
        const system = fakeFileSystem();
        // A symbolic link another local principal pre-placed at the name this
        // run is about to use — the attack the nonce makes a guess and the
        // exclusive create makes a refusal.
        system.symlinks.add(STAGING_DIRECTORY);

        await expect(runReleaseStage(stageDeps(db, system))).rejects.toThrow(ManifestError);

        expect(db.created).toEqual([]);
        expect(system.actions.filter((action) => action.startsWith('rename:'))).toEqual([]);
    });

    it('refuses to stage in a parent other local principals can write, recording no ledger row', async () => {
        const db = fakeDb([], readyLedger());
        const system = fakeFileSystem();
        system.unsafeParents.add(path.dirname(FINAL_DIRECTORY));

        await expect(runReleaseStage(stageDeps(db, system))).rejects.toThrow(ManifestError);

        // The parent is established BEFORE the name is created, so the only
        // thing that happened is the check — no directory, no ledger row, and
        // therefore nothing for an operator to settle afterwards.
        expect(system.actions).toEqual([`safeParent:${STAGING_DIRECTORY}`]);
        expect(db.created).toEqual([]);
    });

    it('sweeps the staging directory of a killed run and leaves a live one alone', async () => {
        const db = fakeDb([], readyLedger());
        const system = fakeFileSystem();
        const orphan = stagingDirFor(FINAL_DIRECTORY, 999, 'ffffffffffffffff');
        const liveRun = stagingDirFor(FINAL_DIRECTORY, 1000, 'eeeeeeeeeeeeeeee');
        system.ensureDir(orphan);
        system.ensureDir(liveRun);
        system.ensureDir(FINAL_DIRECTORY);

        await runReleaseStage(
            stageDeps(db, system, {
                // Only the second staging directory belongs to a running
                // process, which is what makes the first one an orphan.
                pidIsRunning: (pid: number) => pid === 1000,
            }),
        );

        expect(system.actions).toContain(`removeDir:${orphan}`);
        expect(system.directoryExists(orphan)).toBe(false);
        // A concurrent export is still writing into this one, and two exports
        // of one database are meant to be able to run at once.
        expect(system.directoryExists(liveRun)).toBe(true);
        // And nothing that merely lives beside a release is a candidate.
        expect(system.directoryExists(FINAL_DIRECTORY)).toBe(true);
        expect(system.actions).not.toContain(`removeDir:${STAGING_DIRECTORY}`);
    });

    it('records failed and discards staging when publication refuses', async () => {
        const calls: string[] = [];
        const db = fakeDb([], readyLedger(), calls);
        const system = fakeFileSystem();

        await expect(
            runReleaseStage(
                stageDeps(db, system, {
                    publish: () => {
                        throw new ReleasePublicationError('release_directory_exists', 'destination exists');
                    },
                }),
            ),
        ).rejects.toThrow(ReleasePublicationError);

        expect(db.updated[0].data).toMatchObject({ status: 'failed' });
        expect((db.updated[0].data.log as { code?: string }[])[1].code).toBe('release_directory_exists');
        expect(system.actions).toContain(`removeDir:${STAGING_DIRECTORY}`);
    });

    it('records failed when the export itself refuses', async () => {
        const db = fakeDb([], readyLedger());
        const system = fakeFileSystem();

        await expect(
            runReleaseStage(
                stageDeps(db, system, {
                    runExport: async (): Promise<ReleaseOutcome> => {
                        throw new ReleaseIntegrityError('unevidenced rows');
                    },
                }),
            ),
        ).rejects.toThrow(ReleaseIntegrityError);

        expect(db.updated[0].data).toMatchObject({ status: 'failed' });
        expect((db.updated[0].data.log as { code?: string }[])[1].code).toBe('release_integrity_failed');
    });

    it('fails the run when a published release cannot be recorded as succeeded', async () => {
        const db = fakeDb([], readyLedger());
        db.failNextUpdate = true;
        const system = fakeFileSystem();

        await expect(runReleaseStage(stageDeps(db, system))).rejects.toThrow(CatalogReleaseError);
    });

    it('drives the real export and publication through its injected seams', async () => {
        // No `runExport` or `publish` override: the defaults are what main()
        // uses, so this is the orchestration as it ships.
        const db = fakeDb([publishedFood()], readyLedger());
        const system = fakeFileSystem();

        const outcome = await runReleaseStage({
            db,
            coveragePlan,
            release: RELEASE,
            force: false,
            finalDirectory: FINAL_DIRECTORY,
            logger: silentLogger,
            now: () => NOW,
            pid: PID,
            fileSystem: system,
            stagingSuffix: STAGING_SUFFIX,
            pidIsRunning: () => false,
        });

        expect(outcome.publishedFoods).toBe(1);
        // Every member and the manifest were written into STAGING and the
        // directory was then renamed to the reviewed path.
        const staging = STAGING_DIRECTORY;
        for (const member of [...RELEASE_DATA_FILES, RELEASE_MANIFEST_FILE_NAME]) {
            expect(system.files.has(path.join(staging, member))).toBe(true);
        }
        expect(system.actions).toContain(`rename:${staging}->${FINAL_DIRECTORY}`);
        expect(db.updated[0].data).toMatchObject({ status: 'succeeded' });
    });
});

describe('a restricted validation that moved the published set is not certified by the canonical pass', () => {
    const restricted = (overrides: Partial<ReleaseRunRow>, runs: readonly ReleaseRunRow[]): ReleaseRunRow => ({
        kind: 'validation',
        manifest_version: `${canonicalKeyFor(runs)}+scope:abcabcabcabcabc1`,
        status: 'succeeded',
        finished_at: new Date('2026-09-16T09:30:00.000Z'),
        ...overrides,
    });

    const decide = (extra: readonly ReleaseRunRow[], logger: ScriptLogger = silentLogger): string | null => {
        const ledger = readyLedger();
        return releaseStalenessReason([...ledger, ...extra], canonicalKeyFor(ledger), logger);
    };

    it('refuses when a later restricted pass changed dispositions, and states the remedy that exists', () => {
        const ledger = readyLedger();
        const reason = decide([restricted({ counts: { judged: 5, unchanged: 2 } }, ledger)]);

        expect(reason).not.toBeNull();
        expect(reason).toContain('restricted catalog:validate run');
        expect(reason).toContain('changed 3 food publication status(es)');
        expect(reason).toContain('judged only part of the plan');
        // The remedy is the one that can actually clear it: re-running
        // catalog:validate here is the completed-run no-op.
        expect(reason).toContain('completed-run no-op');
        expect(reason).toContain('newer catalog:import or catalog:load');
    });

    it('allows a later restricted pass that judged rows and moved none', () => {
        const ledger = readyLedger();
        const recorder = recordingLogger();

        expect(decide([restricted({ counts: { judged: 4, unchanged: 4 } }, ledger)], recorder.logger)).toBeNull();
        expect(recorder.lines.map((line) => line.event)).toContain('restricted_validation_changed_nothing');
    });

    // WHY AN UNREADABLE COUNT REFUSES WHATEVER THE ROW'S STATUS IS.
    //
    // catalog-validate.ts writes a food's judgement, its count delta, the
    // run-log entry a skipped row earns and the cursor past it in ONE
    // transaction per food (scripts/catalog-validate.ts, THE PER-FOOD UNIT OF
    // WORK), so an interrupted pass leaves counts that agree with the statuses
    // it committed. This rule is about the rows that predate that guarantee and
    // the rows that no longer read: the gate's only evidence is the ledger row
    // in front of it, and `validationDispositionChanges(run.counts)` returns
    // null for ANY row whose counts cannot be read as the judged/unchanged pair
    // — one written while the counts reached the ledger separately from the
    // judgement, or one damaged or partially restored. The gate cannot tell
    // that row from "judged rows and moved none", the single case it allows and
    // the one the test above evidences. A release is an artefact other
    // environments load, so absent evidence resolves against publishing, and
    // `failed` is not a reason to trust it. Nor is housekeeping an argument for
    // an exemption: `settleUnresumableValidationRuns` closes only runs whose
    // parsed input DIFFERS from the current one, so a settled row cannot carry
    // this rule's `<expectedKey>+scope:` prefix in the first place — which the
    // replaced-input case below pins independently.
    it.each(['succeeded', 'failed'])(
        'refuses a %s restricted pass whose ledger records no counts at all',
        (status) => {
            const ledger = readyLedger();
            const recorder = recordingLogger();
            const reason = decide([restricted({ status, counts: undefined }, ledger)], recorder.logger);

            expect(reason).toContain('records no judged/unchanged counts');
            expect(reason).toContain('commits each');
            expect(reason).toContain('does not excuse it from this rule');
            expect(reason).toContain(RESTRICTED_REMEDY_PHRASE);
            // Not warned-and-allowed: there is no "unverified" escape hatch left.
            expect(recorder.lines.map((line) => line.event)).not.toContain('restricted_validation_unverified');
        },
    );

    it.each([{ considered: 9 }, { judged: 'many' }, [1, 2], null])(
        'refuses when the counts are present but do not state what was judged (%p)',
        (counts) => {
            const ledger = readyLedger();

            expect(decide([restricted({ counts }, ledger)])).toContain('records no judged/unchanged counts');
        },
    );

    it('ignores a restricted pass that ran BEFORE the canonical one', () => {
        const ledger = readyLedger();

        expect(
            decide([
                restricted(
                    { counts: { judged: 9, unchanged: 0 }, finished_at: new Date('2026-09-16T08:30:00.000Z') },
                    ledger,
                ),
            ]),
        ).toBeNull();
    });

    it('ignores a restricted pass for a REPLACED catalog input, which is what housekeeping settles', () => {
        // `settleUnresumableValidationRuns` closes such rows as failed with
        // `finished_at` set to now, so they routinely finish after the canonical
        // success while saying nothing about the current set.
        const ledger = readyLedger();

        expect(
            decide([
                {
                    kind: 'validation',
                    manifest_version: `${canonicalValidationRunKey('v1', 'usda_import:gone:2026-01-01T00:00:00.000Z')}+scope:ffffffffffffffff`,
                    status: 'failed',
                    finished_at: new Date('2026-09-16T09:45:00.000Z'),
                    counts: { judged: 12, unchanged: 0 },
                },
            ]),
        ).toBeNull();
    });

    it('names the same run whatever order the ledger came back in', () => {
        const ledger = readyLedger();
        const first = restricted(
            { counts: { judged: 2, unchanged: 0 }, manifest_version: `${canonicalKeyFor(ledger)}+scope:1111111111111111` },
            ledger,
        );
        const second = restricted(
            {
                counts: { judged: 2, unchanged: 0 },
                manifest_version: `${canonicalKeyFor(ledger)}+scope:2222222222222222`,
                finished_at: new Date('2026-09-16T09:50:00.000Z'),
            },
            ledger,
        );

        expect(decide([first, second])).toBe(decide([second, first]));
        expect(decide([first, second])).toContain('+scope:1111111111111111');
        expect(decide([first, second])).toContain('2 restricted runs ran since');
    });

    it('refuses the export before a byte is written, so a stale catalog produces no members', async () => {
        const files = new Map<string, string>();
        const ledger = readyLedger();
        const db = fakeDb([publishedFood()], [...ledger, restricted({ counts: { judged: 3, unchanged: 0 } }, ledger)]);

        await expect(runRelease(exportDeps(db, files))).rejects.toThrow(ReleaseIntegrityError);
        expect(files.size).toBe(0);
    });

    describe('validationDispositionChanges', () => {
        it('is the difference between judged and unchanged', () => {
            expect(validationDispositionChanges({ judged: 7, unchanged: 5 })).toBe(2);
            expect(validationDispositionChanges({ judged: 7 })).toBe(7);
        });

        it('is null when the counts do not state what the pass judged', () => {
            expect(validationDispositionChanges(undefined)).toBeNull();
            expect(validationDispositionChanges(null)).toBeNull();
            expect(validationDispositionChanges([1, 2])).toBeNull();
            expect(validationDispositionChanges({ considered: 4 })).toBeNull();
            expect(validationDispositionChanges({ judged: 'many' })).toBeNull();
        });

        it('never reports a negative change from counters that disagree', () => {
            expect(validationDispositionChanges({ judged: 2, unchanged: 5 })).toBe(0);
        });
    });
});
