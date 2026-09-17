/**
 * The catalog release exporter — `scripts/catalog-release.ts` — on injected
 * doubles.
 *
 * WHY THIS SUITE EXISTS BESIDE `catalog-import.test.ts`. That file already
 * drives `releaseStalenessReason` and the `runRelease` prerequisite pairing
 * against a real ledger, and it keeps doing so. What it cannot reach is the
 * half of the stage that decides what is WRITTEN and what is PUBLISHED: the
 * component closure, the measured model provenance, the overwrite rule and the
 * ledger's states. Those are the five findings this suite pins, and every one of
 * them is a pure decision over injected data — a fake `ReleaseDb` whose
 * `$transaction` hands itself back, a fake filesystem of two maps — so nothing
 * here needs PostgreSQL and the whole file runs in about a second.
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
    publicationLockFor,
    publishRelease,
    releaseStalenessReason,
    runRelease,
    runReleaseStage,
    stagingDirFor,
    validationDispositionChanges,
} from '../../../scripts/catalog-release';
import type {
    PublishReleaseInput,
    ReleaseDb,
    ReleaseFileSystem,
    ReleaseFoodRow,
    ReleaseOutcome,
    ReleaseRunRow,
    RunReleaseDeps,
    RunReleaseStageDeps,
} from '../../../scripts/catalog-release';
import { canonicalValidationRunKey, catalogInputIdentity } from '../../../scripts/lib/checkpoint';
import type { CatalogInputRunRow } from '../../../scripts/lib/checkpoint';
import type { ScriptLogger } from '../../../scripts/lib/logger';
import {
    ManifestError,
    assertCoveragePlanModelShape,
    clearManifestCache,
    loadCoveragePlan,
} from '../../../scripts/lib/manifest';
import type { CatalogReleaseManifest, CoveragePlan } from '../../../scripts/lib/manifest';

const RELEASE = 'v99';
const FINAL_DIRECTORY = '/releases/v99';
const PID = 4242;
const NOW = new Date('2026-09-16T10:00:00.000Z');

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
    identity_evidence: [],
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

const fakeDb = (foods: readonly ReleaseFoodRow[], runs: readonly ReleaseRunRow[], calls: string[] = []): FakeDb => {
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
    readonly locks: Set<string>;
    readonly actions: string[];
    lockHeldByAnother?: boolean;
    /** One `from->to` move to refuse, so a rollback's own move still works. */
    failRename?: string;
}

const fakeFileSystem = (actions: string[] = []): FakeFileSystem => {
    const files = new Map<string, string>();
    const directories = new Set<string>();
    const locks = new Set<string>();

    const system: FakeFileSystem = {
        files,
        directories,
        locks,
        actions,
        writeFile: (absolutePath, contents) => {
            files.set(absolutePath, contents);
        },
        readFileBytes: (absolutePath) => Buffer.from(files.get(absolutePath) ?? '', 'utf-8'),
        ensureDir: (absolutePath) => {
            directories.add(absolutePath);
        },
        removeDir: (absolutePath) => {
            actions.push(`removeDir:${absolutePath}`);
            directories.delete(absolutePath);
        },
        directoryExists: (absolutePath) => directories.has(absolutePath),
        rename: (from, to) => {
            actions.push(`rename:${from}->${to}`);
            if (system.failRename === `${from}->${to}`) {
                throw new Error(`rename into ${to} refused`);
            }
            directories.delete(from);
            directories.add(to);
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

describe("a release's components close over its own foods (F12)", () => {
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

describe('model_versions is measured from the rows, never from configuration (F15, F28)', () => {
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

describe('the coverage plan declares model CONFIGURATION, and it is checked (F28)', () => {
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

describe('publication enforces --force and serialises by final path (F13)', () => {
    const publishInput = (system: FakeFileSystem, force: boolean): PublishReleaseInput => ({
        stagingDirectory: stagingDirFor(FINAL_DIRECTORY, PID),
        finalDirectory: FINAL_DIRECTORY,
        force,
        pid: PID,
        now: () => NOW,
        fileSystem: system,
        logger: silentLogger,
    });

    it('moves staging into place in one rename when nothing is there', () => {
        const system = fakeFileSystem();
        system.ensureDir(stagingDirFor(FINAL_DIRECTORY, PID));

        publishRelease(publishInput(system, false));

        expect(system.actions).toEqual([
            `lock:${publicationLockFor(FINAL_DIRECTORY)}`,
            `rename:${stagingDirFor(FINAL_DIRECTORY, PID)}->${FINAL_DIRECTORY}`,
            `unlock:${publicationLockFor(FINAL_DIRECTORY)}`,
        ]);
        expect(system.directoryExists(FINAL_DIRECTORY)).toBe(true);
    });

    it('refuses a destination that appeared after preflight, rather than replacing it', () => {
        const system = fakeFileSystem();
        system.ensureDir(stagingDirFor(FINAL_DIRECTORY, PID));
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
        system.ensureDir(stagingDirFor(FINAL_DIRECTORY, PID));
        system.ensureDir(FINAL_DIRECTORY);

        publishRelease(publishInput(system, true));

        const superseded = path.join(path.dirname(FINAL_DIRECTORY), `.${path.basename(FINAL_DIRECTORY)}.superseded-${PID}`);
        expect(system.actions).toEqual([
            `lock:${publicationLockFor(FINAL_DIRECTORY)}`,
            `removeDir:${superseded}`,
            `rename:${FINAL_DIRECTORY}->${superseded}`,
            `rename:${stagingDirFor(FINAL_DIRECTORY, PID)}->${FINAL_DIRECTORY}`,
            `removeDir:${superseded}`,
            `unlock:${publicationLockFor(FINAL_DIRECTORY)}`,
        ]);
    });

    it('puts the old release back when the new one cannot take the path', () => {
        const system = fakeFileSystem();
        system.ensureDir(stagingDirFor(FINAL_DIRECTORY, PID));
        system.ensureDir(FINAL_DIRECTORY);
        // Only the NEW release's move fails; the rollback's own move must work.
        system.failRename = `${stagingDirFor(FINAL_DIRECTORY, PID)}->${FINAL_DIRECTORY}`;

        expect(() => publishRelease(publishInput(system, true))).toThrow('refused');
        // The last rename put the reviewed release back where it was.
        expect(system.directoryExists(FINAL_DIRECTORY)).toBe(true);
        expect(system.locks.size).toBe(0);
    });

    it('refuses while another publication holds the final path, touching nothing', () => {
        const system = fakeFileSystem();
        system.ensureDir(stagingDirFor(FINAL_DIRECTORY, PID));
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

describe('the release ledger says succeeded only once the release is at its path (F14, F26)', () => {
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

    it('discards the stale staging directory of a killed run before exporting', async () => {
        const db = fakeDb([], readyLedger());
        const system = fakeFileSystem();
        system.ensureDir(stagingDirFor(FINAL_DIRECTORY, PID));

        await runReleaseStage(stageDeps(db, system));

        expect(system.actions[0]).toBe(`removeDir:${stagingDirFor(FINAL_DIRECTORY, PID)}`);
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
        expect(system.actions).toContain(`removeDir:${stagingDirFor(FINAL_DIRECTORY, PID)}`);
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
        });

        expect(outcome.publishedFoods).toBe(1);
        // Every member and the manifest were written into STAGING and the
        // directory was then renamed to the reviewed path.
        const staging = stagingDirFor(FINAL_DIRECTORY, PID);
        for (const member of [...RELEASE_DATA_FILES, RELEASE_MANIFEST_FILE_NAME]) {
            expect(system.files.has(path.join(staging, member))).toBe(true);
        }
        expect(system.actions).toContain(`rename:${staging}->${FINAL_DIRECTORY}`);
        expect(db.updated[0].data).toMatchObject({ status: 'succeeded' });
    });
});

describe('a restricted validation that moved the published set is not certified by the canonical pass (F33)', () => {
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
    // catalog-validate.ts commits each judged food's new publication status in
    // its own transaction and tallies it only afterwards, in memory, with the
    // tallies reaching the ledger on a periodic flush. A pass that stopped
    // between a commit and the next flush has therefore left status changes the
    // ledger says nothing about — so "no counts" is not evidence of "changed
    // nothing", and `failed` is the status such a pass would most likely carry
    // rather than a reason to trust it. Nor is housekeeping an argument for an
    // exemption: `settleUnresumableValidationRuns` closes only runs whose
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
