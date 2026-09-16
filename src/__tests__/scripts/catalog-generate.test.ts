/**
 * The AI generation stage, and the operator-scoped model-call meter it spends
 * through.
 *
 * WHAT THIS FILE IS FOR. Rule backend-architecture §9 requires "meter before
 * you spend": `src/services/entitlement.service.ts` consumes a user's daily
 * quota BEFORE the LLM call, because a failed call still costs tokens and
 * failures must not become free retries. `catalog-generate-ai.ts` makes the
 * same paid calls with no user to meter, so Agent Action Plan §0.10 moves the
 * ledger to `catalog_generation_batches` and keeps the ordering identical —
 * and names this suite as the place where that ordering stops being a comment
 * and becomes an assertion. Every case under "meter before you spend" and
 * "an exhausted budget" exists for that; the batching, idempotency, refusal and
 * vendor-mapping cases support it.
 *
 * WHY IT NEEDS A DATABASE (§11). The ledger IS the mechanism: the cap is
 * `budgetLimit − SUM(model_calls_reserved)` aggregated per run, and a resumed
 * run spending against the reservations a previous attempt committed cannot be
 * observed anywhere else. The pure halves — the two configuration accessors,
 * `planBatches`, `batchKeyFor`, `assertModelCallBudget` — are asserted with no
 * database, as that rule also requires.
 *
 * HOW IT DRIVES THE STAGE. Through `runGeneration(deps)` only, with the model
 * client, the evidence fetcher, the clock, the report writer and the logger
 * injected (Rule 4: dependency injection over mocking). Nothing here mocks a
 * script or service internal, no vendor is reached, and the budget seam
 * delegates to the real `scripts/lib/budget.ts` functions against the real
 * tables, so a reordering of the stage's reserve/call/record sequence fails
 * these tests rather than passing them.
 *
 * WHAT IT DELIBERATELY DOES NOT COVER. Validation bounds and check verdicts,
 * the brand predicate's own patterns and `buildSourceKey`'s derivation belong
 * to `src/services/__tests__/catalog.logic.test.ts`; the SSRF URL, host and
 * address policy to `evidence.logic.test.ts`; the `OpenRouterError` →
 * `EstimateFailedError` translation to `openrouter.service.test.ts`; the USDA
 * import, its checkpointing and the rate ledger to `catalog-import.test.ts`;
 * release loading to `catalog-load.test.ts`; publication to `catalog-validate`,
 * which is not this folder's charter at all.
 *
 * Jest's `roots` is `<rootDir>/src` (jest.config.ts), so a test file under
 * `scripts/` would never be collected; the relative imports into `scripts/` are
 * the consequence of that, not a choice. `scripts/lib/bootstrap.ts` is
 * deliberately NOT imported: Jest is not a script process, and its
 * `dotenv.config()` would overwrite the environment `jestSetup.ts` controls.
 */
import { prisma } from '../../prisma/client';
import { CATALOG_CHECK_NAMES } from '../../services/catalog.logic';
import type { CatalogValidationVerdict } from '../../services/catalog.logic';
import type { EvidenceFetchResult } from '../../services/evidence.service';
import { OpenRouterError } from '../../services/openrouter.service';
import type { OpenRouterErrorKind } from '../../services/openrouter.service';
import {
    CatalogGenerationError,
    buildGenerationPlan,
    generationPublicationStatus,
    generationRunScope,
    runGeneration,
} from '../../../scripts/catalog-generate-ai';
import type {
    GenerateOptions,
    GenerationBudget,
    GenerationDb,
    GenerationDeps,
    GenerationEvidenceFetcher,
    GenerationModelClient,
    GenerationSummary,
} from '../../../scripts/catalog-generate-ai';
import {
    DEFAULT_CATALOG_BATCH_SIZE,
    ModelBudgetError,
    assertModelCallBudget,
    batchKeyFor,
    getCatalogBatchSize,
    getCatalogModelCallBudget,
    getRemainingModelCalls,
    getReservedModelCalls,
    planBatches,
    recordModelCallUsage,
    reserveModelCall,
} from '../../../scripts/lib/budget';
import { CheckpointError, openRun } from '../../../scripts/lib/checkpoint';
import type { CatalogRunDb } from '../../../scripts/lib/checkpoint';
import { loadCoveragePlan, loadEvidenceAllowlist } from '../../../scripts/lib/manifest';
import type { CoveragePlan } from '../../../scripts/lib/manifest';
import { createLogger } from '../../../scripts/lib/logger';
import type { LogLevel } from '../../../scripts/lib/logger';
import { makeCatalogFood } from '../setup/factories';
import { truncateFeatureTables } from '../setup/testDb';

/* -------------------------------------------------------------------------- *
 * Fixtures
 * -------------------------------------------------------------------------- */

/**
 * The shipped coverage plan and allowlist, loaded once. Nothing here writes to
 * either document or varies it on disk, so the manifest cache is never a source
 * of cross-test state.
 */
const coveragePlan: CoveragePlan = loadCoveragePlan();
const evidencePolicy = loadEvidenceAllowlist() as unknown as GenerationDeps['evidencePolicy'];

/**
 * `protein_egg` is the smallest category the plan declares (candidateVolume 75),
 * so a full-category run is three batches at the plan's own batch size rather
 * than the 70 that `prepared_meal` would need.
 */
const CATEGORY = 'protein_egg';
const FOOD_GROUP = 'chicken_egg';

/**
 * Injected, never resolved from the environment: `getGenerationModel()` reads
 * `CATALOG_GENERATION_MODEL` and falls back through the OpenRouter boundary,
 * which `jestSetup.ts` deliberately leaves unconfigured. A model name passed in
 * as data is what keeps this suite offline by construction.
 */
const MODEL = 'harness/generation-model';

const EVIDENCE_HOST = 'fdc.nal.usda.gov';
const EVIDENCE_PATH = '/fdc-app.html#/food-details/747997/nutrients';
const EVIDENCE_URL = `https://${EVIDENCE_HOST}${EVIDENCE_PATH}`;

/** Every clock the stage can read is this one. No assertion reads the wall clock. */
const FIXED_NOW = new Date('2026-09-14T09:00:00.000Z');

/** The identity the default payload proposes, and the key it must resolve to. */
const FOOD_NAME = 'Poached chicken egg';
const FOOD_SOURCE_KEY = `ai:${CATEGORY}:poached chicken egg:cooked`;

/** A brand word from `DEFAULT_BRAND_WORDS`, which is what makes this a refusal. */
const BRANDED_FOOD_NAME = 'Chobani egg white bites';

const batchKeyOf = (batchIndex: number): string =>
    batchKeyFor(coveragePlan.coveragePlanVersion, CATEGORY, batchIndex);

/**
 * One food as the model would answer it: per-100 g values for a poached egg,
 * inside `protein_egg`'s reviewed 40–350 kcal band and its 15 % energy-vs-macro
 * tolerance (4 × 13 + 4 × 1.1 + 9 × 11 = 155.4 against a stated 155), so the
 * checks that fail are the ones the stage is about rather than arithmetic.
 */
const foodPayload = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
    canonicalName: FOOD_NAME,
    displayName: FOOD_NAME,
    foodState: 'cooked',
    foodGroup: FOOD_GROUP,
    aliases: ['poached egg'],
    caloriesPer100g: 155,
    proteinGPer100g: 13,
    carbsGPer100g: 1.1,
    fatGPer100g: 11,
    fiberGPer100g: 0,
    costClass: 1,
    allergenTags: ['eggs'],
    dietTags: ['vegetarian'],
    defaultPortion: { description: '1 large egg', amount: 1, unit: 'egg', gramWeight: 50 },
    evidenceUrls: [EVIDENCE_URL],
    ...overrides,
});

const batchPayload = (...foods: Record<string, unknown>[]): Record<string, unknown> => ({
    foods: foods.length > 0 ? foods : [foodPayload()],
});

/**
 * A digest of the right length and alphabet, written so it cannot be mistaken
 * for a credential: nothing in this suite hashes a body, and no assertion reads
 * this value.
 */
const FIXTURE_BODY_SHA256 = 'a'.repeat(64);

/** A page that was fetched and names the candidate: identity `verified`. */
const corroborated = (url: string): EvidenceFetchResult => ({
    ok: true,
    record: {
        url,
        finalHost: EVIDENCE_HOST,
        status: 200,
        bodySha256: FIXTURE_BODY_SHA256,
        matchedSnippet: 'Egg, whole, cooked, poached',
        fetchedAt: FIXED_NOW.toISOString(),
    },
});

/** A refusal, which leaves the candidate unsourced. Which refusals exist and why
 * is `evidence.logic.test.ts`'s subject; this file only needs one. */
const uncorroborated = (): EvidenceFetchResult => ({
    ok: false,
    reason: 'host_not_allowlisted',
    detail: 'the harness refused this host',
    host: 'example.test',
    error: null,
});

/* -------------------------------------------------------------------------- *
 * The injected seams
 * -------------------------------------------------------------------------- */

interface ModelCall {
    readonly ordinal: number;
    readonly model: string;
    readonly systemPrompt: string;
    readonly userContent: string;
    readonly schema: Record<string, unknown>;
    /** The ledger as it stood WHEN THE VENDOR WAS CALLED, read through the real accessors. */
    readonly reservedAtCall: number;
    readonly remainingAtCall: number;
}

interface EvidenceCall {
    readonly url: string;
    readonly expectedName: string;
    readonly evidenceType: string;
}

/**
 * The ordering the §9 rule is about, recorded as it happens. A reservation is
 * appended once `reserveModelCall` has RETURNED, so `reserve` preceding `call`
 * in this list is the ordering claim and not an artefact of when the entry was
 * pushed.
 */
type Interaction =
    | { readonly kind: 'reserve'; readonly batchKey: string; readonly reserved: number }
    | { readonly kind: 'call'; readonly ordinal: number }
    | { readonly kind: 'record'; readonly batchKey: string; readonly succeeded: boolean };

interface LoggedLine {
    readonly level: LogLevel;
    readonly line: string;
}

interface Harness {
    readonly deps: GenerationDeps;
    readonly budgetLimit: number;
    readonly modelCalls: readonly ModelCall[];
    readonly evidenceCalls: readonly EvidenceCall[];
    readonly interactions: readonly Interaction[];
    readonly reports: readonly unknown[];
    readonly lines: readonly LoggedLine[];
    /** Every captured line, parsed. */
    entries(): Record<string, unknown>[];
    entriesFor(event: string): Record<string, unknown>[];
    /** Every captured line as one string, for the "this never appears" assertions. */
    output(): string;
}

interface HarnessOptions {
    /** The model's answer per call ordinal. Throwing is a vendor failure. */
    readonly respond?: (ordinal: number) => unknown;
    readonly evidence?: (url: string) => EvidenceFetchResult;
    readonly budgetLimit?: number;
    readonly batchSize?: number;
    readonly maxBatches?: number | null;
    readonly categories?: readonly string[];
    readonly logLevel?: LogLevel;
}

/**
 * The graph seam takes the real client through a cast, exactly as the stage's
 * own `main()` does: `GenerationDb` declares `catalog_food_aliases.findMany` as
 * returning its rows WITH the `catalog_foods.source_key` include, which the
 * generated client's default payload type does not carry, so the structural
 * seam and the generated types cannot be reconciled by annotation. The rows are
 * real and the statements are the stage's own.
 */
const graphDb = prisma as unknown as GenerationDb;
const runDb: CatalogRunDb = prisma;

const optionsOf = (overrides: Partial<GenerateOptions> = {}): GenerateOptions => ({
    help: false,
    categories: [CATEGORY],
    batchSize: null,
    maxBatches: 1,
    resume: false,
    dryRun: false,
    ...overrides,
});

const runScopeOf = (options: GenerateOptions): string =>
    generationRunScope(coveragePlan.coveragePlanVersion, options);

/**
 * The run this stage is working, resolved from the table rather than passed in:
 * the model seam has to read the ledger at the moment it is called, and the
 * stage does not hand its run id to the vendor boundary.
 */
const currentRunId = async (): Promise<string> => {
    const row = await prisma.catalog_import_runs.findFirstOrThrow({
        where: { kind: 'ai_generation' },
        orderBy: { started_at: 'desc' },
        select: { id: true },
    });
    return row.id;
};

const createHarness = (harnessOptions: HarnessOptions = {}): Harness => {
    const budgetLimit = harnessOptions.budgetLimit ?? 8;
    const respond = harnessOptions.respond ?? ((): unknown => batchPayload());
    const evidence = harnessOptions.evidence ?? corroborated;

    const modelCalls: ModelCall[] = [];
    const evidenceCalls: EvidenceCall[] = [];
    const interactions: Interaction[] = [];
    const reports: unknown[] = [];
    const lines: LoggedLine[] = [];

    const openRouter: GenerationModelClient = {
        call: async (systemPrompt, userContent, jsonSchema, model) => {
            const runId = await currentRunId();
            modelCalls.push({
                ordinal: modelCalls.length + 1,
                model,
                systemPrompt,
                userContent,
                schema: jsonSchema as Record<string, unknown>,
                reservedAtCall: await getReservedModelCalls(runDb, runId),
                remainingAtCall: await getRemainingModelCalls(runDb, runId, budgetLimit),
            });
            interactions.push({ kind: 'call', ordinal: modelCalls.length });

            return respond(modelCalls.length);
        },
    };

    const fetchEvidence: GenerationEvidenceFetcher = async (url, expectedName, _policy, evidenceType) => {
        evidenceCalls.push({ url, expectedName, evidenceType: String(evidenceType) });
        return evidence(url);
    };

    // Delegating to the real ledger, never standing in for it: the cap this
    // suite asserts is enforced by those functions against those rows.
    const budget: GenerationBudget = {
        reserve: async (input) => {
            const outcome = await reserveModelCall(runDb, input);
            interactions.push({ kind: 'reserve', batchKey: input.batchKey, reserved: outcome.reserved });
            return outcome;
        },
        record: async (input) => {
            await recordModelCallUsage(runDb, input);
            interactions.push({ kind: 'record', batchKey: input.batchKey, succeeded: input.succeeded });
        },
        reserved: (runId) => getReservedModelCalls(runDb, runId),
    };

    const deps: GenerationDeps = {
        prisma: graphDb,
        runDb,
        openRouter,
        fetchEvidence,
        now: () => FIXED_NOW,
        budget,
        coveragePlan,
        evidencePolicy,
        options: optionsOf({
            categories: harnessOptions.categories ?? [CATEGORY],
            maxBatches: harnessOptions.maxBatches === undefined ? 1 : harnessOptions.maxBatches,
        }),
        logger: createLogger('catalog-generate-ai', {
            level: harnessOptions.logLevel ?? 'debug',
            write: (line, level) => {
                lines.push({ line, level });
            },
            now: () => FIXED_NOW,
        }),
        model: MODEL,
        batchSize: harnessOptions.batchSize ?? coveragePlan.defaultBatchSize,
        budgetLimit,
        writeReport: (report) => {
            reports.push(report);
        },
    };

    const entries = (): Record<string, unknown>[] =>
        lines.map((entry) => JSON.parse(entry.line) as Record<string, unknown>);

    return {
        deps,
        budgetLimit,
        modelCalls,
        evidenceCalls,
        interactions,
        reports,
        lines,
        entries,
        entriesFor: (event) => entries().filter((entry) => entry.event === event),
        output: () => lines.map((entry) => entry.line).join('\n'),
    };
};

/* -------------------------------------------------------------------------- *
 * Reading the outcome
 * -------------------------------------------------------------------------- */

const thrownBy = (run: () => unknown): unknown => {
    try {
        run();
        return null;
    } catch (error) {
        return error;
    }
};

const modelBudgetErrorFrom = (run: () => unknown): ModelBudgetError => {
    const error = thrownBy(run);
    expect(error).toBeInstanceOf(ModelBudgetError);
    return error as ModelBudgetError;
};

const rejectionOf = async (work: Promise<unknown>): Promise<unknown> =>
    work.then(
        () => null,
        (error: unknown) => error,
    );

const generationFailureOf = async (work: Promise<unknown>): Promise<CatalogGenerationError> => {
    const error = await rejectionOf(work);
    expect(error).toBeInstanceOf(CatalogGenerationError);
    return error as CatalogGenerationError;
};

interface BatchLedgerRow {
    readonly status: string;
    readonly model_calls_reserved: number;
    readonly model_calls_used: number;
    readonly tokens_used: number;
    readonly candidate_count: number;
    readonly accepted_count: number;
}

const batchLedgerRow = async (batchKey: string): Promise<BatchLedgerRow> =>
    prisma.catalog_generation_batches.findUniqueOrThrow({
        where: { batch_key: batchKey },
        select: {
            status: true,
            model_calls_reserved: true,
            model_calls_used: true,
            tokens_used: true,
            candidate_count: true,
            accepted_count: true,
        },
    });

const batchKeysInTable = async (): Promise<string[]> =>
    (
        await prisma.catalog_generation_batches.findMany({
            orderBy: { batch_key: 'asc' },
            select: { batch_key: true },
        })
    ).map((row) => row.batch_key);

const runRow = async (
    runId: string,
): Promise<{
    status: string;
    finished_at: Date | null;
    cursor: unknown;
    counts: unknown;
    log: unknown;
}> =>
    prisma.catalog_import_runs.findUniqueOrThrow({
        where: { id: runId },
        select: { status: true, finished_at: true, cursor: true, counts: true, log: true },
    });

const runCounts = async (runId: string): Promise<Record<string, number>> =>
    ((await runRow(runId)).counts ?? {}) as Record<string, number>;

const runLogEvents = async (runId: string): Promise<string[]> =>
    (((await runRow(runId)).log ?? []) as Record<string, unknown>[]).map((entry) => String(entry.event));

const generatedFoodRows = async (): Promise<
    {
        id: string;
        source_key: string;
        canonical_name: string;
        publication_status: string;
        identity_source: string;
        identity_status: string;
        nutrition_provenance: string;
        allergen_status: string;
        search_text: string | null;
    }[]
> =>
    prisma.catalog_foods.findMany({
        orderBy: { source_key: 'asc' },
        select: {
            id: true,
            source_key: true,
            canonical_name: true,
            publication_status: true,
            identity_source: true,
            identity_status: true,
            nutrition_provenance: true,
            allergen_status: true,
            search_text: true,
        },
    });

/**
 * Seeds the reservations a previous attempt of this run committed.
 *
 * It uses the real ledger under a cap of its own, because that is what a
 * previous attempt did: the reservations are rows, and a resumed invocation has
 * to spend against them whatever cap it is given now.
 */
const seedPriorAttempt = async (
    options: GenerateOptions,
    reservations: readonly number[],
): Promise<string> => {
    const run = await openRun(runDb, { kind: 'ai_generation', manifestVersion: runScopeOf(options) });

    for (const batchIndex of reservations) {
        await reserveModelCall(runDb, {
            runId: run.id,
            batchKey: batchKeyOf(batchIndex),
            category: CATEGORY,
            model: MODEL,
            promptVersion: coveragePlan.promptVersion,
            budgetLimit: 99,
        });
    }

    return run.id;
};

/* -------------------------------------------------------------------------- *
 * The configuration accessors — no database, no process environment.
 *
 * Every variation is an env OBJECT passed as a parameter. `process.env` is
 * never assigned to: the identity guard in `src/__tests__/setup/testDb.ts`
 * reads `NODE_ENV`, `ALLOW_DB_TRUNCATE` and `DATABASE_URL` from it before every
 * truncation, so mutating it here would disarm the guard that keeps this suite
 * pointed at a disposable database.
 * -------------------------------------------------------------------------- */

describe('getCatalogModelCallBudget', () => {
    it.each([
        ['absent', {}],
        ['blank', { CATALOG_MODEL_CALL_BUDGET: '' }],
        ['whitespace only', { CATALOG_MODEL_CALL_BUDGET: '   ' }],
        ['not a number', { CATALOG_MODEL_CALL_BUDGET: 'abc' }],
        ['zero', { CATALOG_MODEL_CALL_BUDGET: '0' }],
        ['negative', { CATALOG_MODEL_CALL_BUDGET: '-5' }],
        ['fractional', { CATALOG_MODEL_CALL_BUDGET: '12.5' }],
        ['hexadecimal', { CATALOG_MODEL_CALL_BUDGET: '0x10' }],
        ['an exponent', { CATALOG_MODEL_CALL_BUDGET: '1e3' }],
    ])('refuses a %s cap with budget_misconfigured', (_description, env: NodeJS.ProcessEnv) => {
        expect(modelBudgetErrorFrom(() => getCatalogModelCallBudget(env)).code).toBe('budget_misconfigured');
    });

    it('accepts a positive integer', () => {
        expect(getCatalogModelCallBudget({ CATALOG_MODEL_CALL_BUDGET: '1500' })).toBe(1500);
    });

    it('has no default, unlike getCatalogBatchSize, which falls back to the reviewed plan value', () => {
        expect(modelBudgetErrorFrom(() => getCatalogModelCallBudget({})).code).toBe('budget_misconfigured');
        expect(getCatalogBatchSize({})).toBe(DEFAULT_CATALOG_BATCH_SIZE);
        expect(DEFAULT_CATALOG_BATCH_SIZE).toBe(coveragePlan.defaultBatchSize);
    });

    it('reports the cap without echoing the raw value', () => {
        const error = modelBudgetErrorFrom(() =>
            getCatalogModelCallBudget({ CATALOG_MODEL_CALL_BUDGET: 'not-a-cap' }),
        );

        expect(error.reserved).toBeNull();
        expect(error.limit).toBeNull();
        expect(error.message).not.toContain('not-a-cap');
    });
});

describe('getCatalogBatchSize', () => {
    it('refuses a present but unusable batch size rather than defaulting', () => {
        expect(modelBudgetErrorFrom(() => getCatalogBatchSize({ CATALOG_BATCH_SIZE: 'wide' })).code).toBe(
            'budget_misconfigured',
        );
        expect(modelBudgetErrorFrom(() => getCatalogBatchSize({ CATALOG_BATCH_SIZE: '0' })).code).toBe(
            'budget_misconfigured',
        );
    });

    it('takes an explicit size over the default', () => {
        expect(getCatalogBatchSize({ CATALOG_BATCH_SIZE: '40' })).toBe(40);
    });
});

/* -------------------------------------------------------------------------- *
 * Batch identity — what makes a rerun address the same batches.
 * -------------------------------------------------------------------------- */

describe('batchKeyFor', () => {
    it('builds the coverage plan`s documented key, zero-padded to four digits', () => {
        const version = coveragePlan.coveragePlanVersion;

        expect(batchKeyFor(version, 'protein_plant', 0)).toBe('v1:protein_plant:0000');
        expect(batchKeyFor(version, 'protein_plant', 17)).toBe('v1:protein_plant:0017');
        expect(batchKeyFor(version, 'protein_plant', 123)).toBe('v1:protein_plant:0123');
        expect(batchKeyFor(version, 'protein_plant', 1234)).toBe('v1:protein_plant:1234');
    });

    it('keeps a key unique past the pad width, losing only the sort order', () => {
        expect(batchKeyFor(coveragePlan.coveragePlanVersion, 'prepared_meal', 12345)).toBe(
            'v1:prepared_meal:12345',
        );
    });

    it('refuses a negative index', () => {
        expect(
            modelBudgetErrorFrom(() => batchKeyFor(coveragePlan.coveragePlanVersion, CATEGORY, -1)).code,
        ).toBe('budget_misconfigured');
    });
});

describe('planBatches', () => {
    const batchSize = coveragePlan.defaultBatchSize;
    const modelCallsPerBatch = coveragePlan.modelCallsPerBatch;

    it('carries the remainder in a tail batch', () => {
        const proteinPlant = coveragePlan.categories.find((entry) => entry.category === 'protein_plant');

        expect(proteinPlant?.candidateVolume).toBe(438);

        const plan = planBatches({
            aiCandidatesByCategory: { protein_plant: 438 },
            batchSize,
            modelCallsPerBatch,
        });

        // 17 full batches of 25 and a tail of 13 — dropping the tail would miss
        // the category's published target by those 13 candidates.
        expect(plan.batchesByCategory.protein_plant).toBe(18);
        expect(plan.totalBatches).toBe(18);
        expect(17 * batchSize + 13).toBe(438);
    });

    it('needs no tail for an exact multiple', () => {
        const plan = planBatches({
            aiCandidatesByCategory: { protein_egg: 100 },
            batchSize,
            modelCallsPerBatch,
        });

        expect(plan.batchesByCategory.protein_egg).toBe(4);
        expect(plan.totalBatches).toBe(4);
    });

    it('keeps a category the import already covered, with zero batches', () => {
        const plan = planBatches({
            aiCandidatesByCategory: { protein_egg: 0, dairy: -5 },
            batchSize,
            modelCallsPerBatch,
        });

        expect(plan.batchesByCategory).toEqual({ protein_egg: 0, dairy: 0 });
        expect(plan.totalBatches).toBe(0);
        expect(plan.estimatedModelCalls).toBe(0);
    });

    it('costs the plan`s own calls-per-batch factor, not a literal', () => {
        const plan = planBatches({
            aiCandidatesByCategory: { protein_egg: 75, nut_seed: 438 },
            batchSize,
            modelCallsPerBatch,
        });

        expect(plan.totalBatches).toBe(3 + 18);
        expect(plan.estimatedModelCalls).toBe(plan.totalBatches * modelCallsPerBatch);
    });

    it('refuses a coverage plan whose candidate count is not a number', () => {
        expect(
            modelBudgetErrorFrom(() =>
                planBatches({
                    aiCandidatesByCategory: { protein_egg: Number.NaN },
                    batchSize,
                    modelCallsPerBatch,
                }),
            ).code,
        ).toBe('budget_misconfigured');
    });
});

/* -------------------------------------------------------------------------- *
 * The startup gate — the run is refused before it spends anything.
 * -------------------------------------------------------------------------- */

describe('assertModelCallBudget', () => {
    const planOf = (aiCandidates: number) =>
        planBatches({
            aiCandidatesByCategory: { [CATEGORY]: aiCandidates },
            batchSize: coveragePlan.defaultBatchSize,
            modelCallsPerBatch: coveragePlan.modelCallsPerBatch,
        });

    const capturingLogger = (): { logger: ReturnType<typeof createLogger>; entries: () => Record<string, unknown>[] } => {
        const lines: string[] = [];
        return {
            logger: createLogger('catalog-generate-ai', {
                level: 'debug',
                write: (line) => {
                    lines.push(line);
                },
                now: () => FIXED_NOW,
            }),
            entries: () => lines.map((line) => JSON.parse(line) as Record<string, unknown>),
        };
    };

    it('logs the estimate when the plan fits', () => {
        const { logger, entries } = capturingLogger();
        const plan = planOf(75);

        assertModelCallBudget(plan, plan.estimatedModelCalls, logger);

        expect(entries()).toEqual([
            expect.objectContaining({
                event: 'model_budget_estimate',
                totalBatches: 3,
                modelCallsPerBatch: coveragePlan.modelCallsPerBatch,
                estimatedModelCalls: plan.estimatedModelCalls,
                budgetLimit: plan.estimatedModelCalls,
            }),
        ]);
    });

    it('accepts a plan that needs exactly its budget', () => {
        const plan = planOf(75);

        expect(() => assertModelCallBudget(plan, plan.estimatedModelCalls)).not.toThrow();
    });

    it('refuses a plan that needs more than the cap, and logs the estimate anyway', () => {
        const { logger, entries } = capturingLogger();
        const plan = planOf(75);
        const limit = plan.estimatedModelCalls - 1;

        const error = modelBudgetErrorFrom(() => assertModelCallBudget(plan, limit, logger));

        expect(error.code).toBe('budget_insufficient');
        expect(error.limit).toBe(limit);
        // Nothing has been reserved yet, so there is no reservation to report.
        expect(error.reserved).toBeNull();
        expect(entries()).toEqual([
            expect.objectContaining({ event: 'model_budget_estimate', estimatedModelCalls: plan.estimatedModelCalls }),
        ]);
    });
});

describe('generationPublicationStatus', () => {
    const verdictWith = (publicationStatus: string): CatalogValidationVerdict =>
        ({ publicationStatus }) as CatalogValidationVerdict;

    it('writes a publishable record as a candidate, because generation never publishes', () => {
        expect(generationPublicationStatus(verdictWith('published'))).toBe('candidate');
    });

    it('passes every other disposition through unchanged', () => {
        expect(generationPublicationStatus(verdictWith('quarantined'))).toBe('quarantined');
        expect(generationPublicationStatus(verdictWith('rejected'))).toBe('rejected');
    });
});

/* -------------------------------------------------------------------------- *
 * Against the ledger.
 *
 * From here every case runs `runGeneration` over the real tables, because the
 * reservation ledger is the mechanism under test rather than a detail of it.
 * -------------------------------------------------------------------------- */

/** A well-formed id no run carries, for the "no such run" path. */
const UNKNOWN_RUN_ID = '00000000-0000-4000-8000-000000000000';

const modelBudgetRejection = async (work: Promise<unknown>): Promise<ModelBudgetError> => {
    const error = await rejectionOf(work);
    expect(error).toBeInstanceOf(ModelBudgetError);
    return error as ModelBudgetError;
};

const reserveOnce = (
    runId: string,
    batchIndex: number,
    budgetLimit: number,
): Promise<{ reserved: number; remaining: number }> =>
    reserveModelCall(runDb, {
        runId,
        batchKey: batchKeyOf(batchIndex),
        category: CATEGORY,
        model: MODEL,
        promptVersion: coveragePlan.promptVersion,
        budgetLimit,
    });

afterAll(async () => {
    // The whole suite shares one test database with its siblings, and `npm test`
    // runs them in band.
    await truncateFeatureTables();
});

describe('catalog-generate-ai.ts — meter before you spend', () => {
    beforeEach(async () => {
        await truncateFeatureTables();
    });

    it('reserves the call, then makes it, then records the usage', async () => {
        const harness = createHarness();

        const summary: GenerationSummary = await runGeneration(harness.deps);
        const batchKey = batchKeyOf(0);

        expect(summary.stopReason).toBe('completed');
        expect(summary.executedBatches).toBe(1);
        expect(summary.modelCallsReserved).toBe(1);
        expect(summary.modelCallsUsed).toBe(1);
        expect(harness.interactions).toEqual([
            { kind: 'reserve', batchKey, reserved: 1 },
            { kind: 'call', ordinal: 1 },
            { kind: 'record', batchKey, succeeded: true },
        ]);
        expect(await batchLedgerRow(batchKey)).toMatchObject({
            status: 'generated',
            model_calls_reserved: 1,
            model_calls_used: 1,
            // The vendor boundary surfaces no usage block, so a token count here
            // would be invented.
            tokens_used: 0,
        });
    });

    it('has already committed the reservation by the time the vendor is called', async () => {
        const harness = createHarness();

        await runGeneration(harness.deps);

        expect(harness.modelCalls).toHaveLength(1);
        expect(harness.modelCalls[0].reservedAtCall).toBe(1);
        expect(harness.modelCalls[0].remainingAtCall).toBe(harness.budgetLimit - 1);
        expect(harness.modelCalls[0].model).toBe(MODEL);
    });

    it('reserves once per batch, and every single call sees its own reservation', async () => {
        const harness = createHarness({ maxBatches: 3 });

        const summary = await runGeneration(harness.deps);

        expect(summary.executedBatches).toBe(3);
        expect(harness.modelCalls.map((call) => call.reservedAtCall)).toEqual([1, 2, 3]);
        expect(harness.modelCalls.map((call) => call.remainingAtCall)).toEqual([
            harness.budgetLimit - 1,
            harness.budgetLimit - 2,
            harness.budgetLimit - 3,
        ]);
        expect(harness.interactions).toEqual([
            { kind: 'reserve', batchKey: batchKeyOf(0), reserved: 1 },
            { kind: 'call', ordinal: 1 },
            { kind: 'record', batchKey: batchKeyOf(0), succeeded: true },
            { kind: 'reserve', batchKey: batchKeyOf(1), reserved: 2 },
            { kind: 'call', ordinal: 2 },
            { kind: 'record', batchKey: batchKeyOf(1), succeeded: true },
            { kind: 'reserve', batchKey: batchKeyOf(2), reserved: 3 },
            { kind: 'call', ordinal: 3 },
            { kind: 'record', batchKey: batchKeyOf(2), succeeded: true },
        ]);
    });

    it('keeps the reservation of a call that failed, and records the usage anyway', async () => {
        const harness = createHarness({
            respond: () => {
                throw new OpenRouterError('http', 'the vendor rejected the request', 502);
            },
        });

        const failure = await generationFailureOf(runGeneration(harness.deps));
        const batchKey = batchKeyOf(0);
        const runId = await currentRunId();

        expect(failure.code).toBe('model_call_failed');
        // The vendor was called, so the tokens were spent whatever it answered.
        // Refunding here would make every failure a free retry, which is the
        // defect §9's ordering exists to prevent.
        expect(await batchLedgerRow(batchKey)).toMatchObject({
            status: 'failed',
            model_calls_reserved: 1,
            model_calls_used: 1,
        });
        expect(await getReservedModelCalls(runDb, runId)).toBe(1);
        expect(await getRemainingModelCalls(runDb, runId, harness.budgetLimit)).toBe(
            harness.budgetLimit - 1,
        );
        expect(harness.interactions).toEqual([
            { kind: 'reserve', batchKey, reserved: 1 },
            { kind: 'call', ordinal: 1 },
            { kind: 'record', batchKey, succeeded: false },
        ]);
        expect((await runRow(runId)).status).toBe('failed');
    });

    it('charges a retry of the same batch a second reservation', async () => {
        const failing = createHarness({
            respond: () => {
                throw new OpenRouterError('network', 'the connection was reset');
            },
        });
        await generationFailureOf(runGeneration(failing.deps));

        const runId = await currentRunId();
        const retrying = createHarness();

        const summary = await runGeneration(retrying.deps);

        expect(summary.runId).toBe(runId);
        expect(summary.resumed).toBe(true);
        expect(await prisma.catalog_import_runs.count()).toBe(1);
        expect(await batchLedgerRow(batchKeyOf(0))).toMatchObject({
            status: 'generated',
            model_calls_reserved: 2,
            model_calls_used: 2,
        });
        expect(summary.modelCallsReserved).toBe(2);
        expect(await getReservedModelCalls(runDb, runId)).toBe(2);
    });

    it('throws budget_exhausted before any increment, leaving the ledger as it was', async () => {
        const options = optionsOf();
        const runId = await seedPriorAttempt(options, [0, 0]);
        const before = await batchLedgerRow(batchKeyOf(0));

        const error = await modelBudgetRejection(reserveOnce(runId, 0, 2));

        expect(error.code).toBe('budget_exhausted');
        expect(error.reserved).toBe(2);
        expect(error.limit).toBe(2);
        expect(await batchLedgerRow(batchKeyOf(0))).toEqual(before);
        expect(await getReservedModelCalls(runDb, runId)).toBe(2);
    });

    it('refuses to record usage for a batch nothing reserved', async () => {
        const runId = await seedPriorAttempt(optionsOf(), []);

        const error = await modelBudgetRejection(
            recordModelCallUsage(runDb, { runId, batchKey: batchKeyOf(3), succeeded: true }),
        );

        expect(error.code).toBe('batch_not_found');
    });

    it('creates the row it meters, so a reservation is never made without one', async () => {
        const runId = await seedPriorAttempt(optionsOf(), []);

        expect(await reserveOnce(runId, 2, 8)).toEqual({ reserved: 1, remaining: 7 });
        expect(await batchLedgerRow(batchKeyOf(2))).toMatchObject({
            status: 'pending',
            model_calls_reserved: 1,
            model_calls_used: 0,
        });
    });

    it('refuses a run that does not exist through checkpoint`s own error', async () => {
        const error = await rejectionOf(reserveOnce(UNKNOWN_RUN_ID, 0, 8));

        expect(error).toBeInstanceOf(CheckpointError);
        expect(error).not.toBeInstanceOf(ModelBudgetError);
        expect((error as CheckpointError).code).toBe('run_not_found');
        expect(await prisma.catalog_generation_batches.count()).toBe(0);
    });

    it('refuses the whole run before the first call when the plan cannot fit the cap', async () => {
        const harness = createHarness({ maxBatches: 2, budgetLimit: 3 });

        const failure = await generationFailureOf(runGeneration(harness.deps));

        expect(failure.code).toBe('budget_insufficient');
        expect(failure.context.detail).toBe('budget_insufficient');
        expect(harness.modelCalls).toHaveLength(0);
        expect(harness.interactions).toHaveLength(0);
        // The gate runs before the run is claimed, so nothing was even opened.
        expect(await prisma.catalog_import_runs.count()).toBe(0);
        expect(await prisma.catalog_generation_batches.count()).toBe(0);
        expect(harness.entriesFor('model_budget_estimate')).toHaveLength(1);
    });
});

/* -------------------------------------------------------------------------- *
 * An exhausted budget, and what a resume spends against.
 *
 * THE STARTUP GATE MAKES MID-RUN EXHAUSTION A RESUME PROPERTY. It refuses any
 * invocation whose executable plan needs more calls than the cap, so a FRESH
 * run always fits and can never exhaust itself. A run reaches the cap only
 * because earlier attempts of the same run already hold reservations — which is
 * exactly the state these cases set up, and the state a resumed run has to
 * spend against.
 * -------------------------------------------------------------------------- */

describe('an exhausted budget pauses the run, and a resume continues against the ledger', () => {
    beforeEach(async () => {
        await truncateFeatureTables();
    });

    /** Two executable batches, three reservations already committed, a cap of four. */
    const pausedRun = async (): Promise<{ runId: string; harness: Harness; summary: GenerationSummary }> => {
        const options = optionsOf({ maxBatches: 2 });
        const runId = await seedPriorAttempt(options, [0, 0, 1]);
        const harness = createHarness({ maxBatches: 2, budgetLimit: 4 });

        return { runId, harness, summary: await runGeneration(harness.deps) };
    };

    it('stops at the batch it cannot pay for, keeping the run open and the checkpoint intact', async () => {
        const { runId, harness, summary } = await pausedRun();

        expect(summary.stopReason).toBe('budget_exhausted');
        expect(summary.runId).toBe(runId);
        expect(summary.resumed).toBe(true);
        expect(summary.plannedBatches).toBe(2);
        expect(summary.executedBatches).toBe(1);
        expect(summary.modelCallsReserved).toBe(4);
        expect(summary.modelCallsUsed).toBe(1);

        const row = await runRow(runId);
        expect(row.status).toBe('running');
        expect(row.finished_at).toBeNull();
        expect(row.cursor).toMatchObject({ nextBatchIndex: 1, modelCallsReserved: 4 });
        expect(await runLogEvents(runId)).toContain('budget_exhausted');

        // The batch it did pay for is complete and its candidate is persisted;
        // the one it could not is untouched at the reservation a previous
        // attempt made.
        expect(await batchLedgerRow(batchKeyOf(0))).toMatchObject({
            status: 'generated',
            model_calls_reserved: 3,
            model_calls_used: 1,
        });
        expect(await batchLedgerRow(batchKeyOf(1))).toMatchObject({
            status: 'pending',
            model_calls_reserved: 1,
            model_calls_used: 0,
        });
        expect(harness.modelCalls).toHaveLength(1);
        expect(await prisma.catalog_foods.count()).toBe(1);
    });

    it('reports the shortfall rather than implying the catalog is complete', async () => {
        const { summary } = await pausedRun();

        // Generation publishes nothing, so every category is still short of its
        // published target by the whole of it.
        expect(summary.shortfallTotal).toBe(coveragePlan.publishedTargetTotal);
    });

    it('resumes the same run, re-generates nothing already complete, and spends against what is left', async () => {
        const { runId } = await pausedRun();
        const resumed = createHarness({ maxBatches: 2, budgetLimit: 6 });

        const summary = await runGeneration(resumed.deps);

        expect(summary.runId).toBe(runId);
        expect(summary.resumed).toBe(true);
        expect(await prisma.catalog_import_runs.count()).toBe(1);
        expect(summary.stopReason).toBe('completed');
        expect(summary.executedBatches).toBe(1);
        expect(resumed.modelCalls).toHaveLength(1);
        // The checkpoint put the loop past the completed batch, and its ledger
        // row is untouched — the batch was not re-generated.
        expect(await batchLedgerRow(batchKeyOf(0))).toMatchObject({
            status: 'generated',
            model_calls_reserved: 3,
            model_calls_used: 1,
        });

        // THE LOAD-BEARING ASSERTION. The resumed invocation was given a cap of
        // six with four calls already reserved, so its one call is the fifth of
        // the run and not the first: a resume that forgot the earlier
        // reservations would read 1 here and silently double the spend.
        expect(resumed.modelCalls[0].reservedAtCall).toBe(5);
        expect(resumed.modelCalls[0].remainingAtCall).toBe(1);
        expect(summary.modelCallsReserved).toBe(5);
        expect(await getReservedModelCalls(runDb, runId)).toBe(5);
        expect(await getRemainingModelCalls(runDb, runId, 6)).toBe(1);
        expect(resumed.entriesFor('run_claimed')).toEqual([
            expect.objectContaining({
                resumed: true,
                modelCallsReservedLedger: 4,
                budgetLimit: 6,
                budgetRemaining: 2,
            }),
        ]);
        expect((await runRow(runId)).status).toBe('succeeded');
    });

    it('skips a batch recorded complete rather than re-generating it when the work list changed', async () => {
        const { runId } = await pausedRun();
        // A different batch size is a different work list, so the saved index
        // names a different batch and the run restarts from zero. What keeps
        // the completed batch from being paid for twice is its recorded status.
        const resumed = createHarness({ maxBatches: 2, budgetLimit: 6, batchSize: 38 });

        const summary = await runGeneration(resumed.deps);

        expect(resumed.entriesFor('cursor_plan_changed')).toHaveLength(1);
        expect(summary.skippedBatches).toBe(1);
        expect(summary.executedBatches).toBe(1);
        expect(resumed.modelCalls).toHaveLength(1);
        expect(await batchLedgerRow(batchKeyOf(0))).toMatchObject({
            status: 'generated',
            model_calls_reserved: 3,
            model_calls_used: 1,
        });
        expect(await getReservedModelCalls(runDb, runId)).toBe(5);
    });

    it('accumulates the run`s counters across attempts rather than replacing them', async () => {
        const { runId } = await pausedRun();
        const resumed = createHarness({ maxBatches: 2, budgetLimit: 6 });

        await runGeneration(resumed.deps);

        const counts = await runCounts(runId);

        // One per attempt that processed a batch: a mirror that replaced rather
        // than merged would report only the resume's single batch.
        expect(counts.batchesProcessed).toBe(2);
        // The mirror adds everything written into it, and the closing call adds
        // the whole tally on top of the per-call records — which is why it reads
        // higher than the ledger. The aggregate below is the authority the cap
        // is enforced against; this column is a diagnostic.
        expect(counts.modelCallsUsed).toBe(3);
        expect(counts.modelCallsReserved).toBe(10);
        expect(await getReservedModelCalls(runDb, runId)).toBe(5);
    });

    it('refuses a cap below what the resumed plan needs, before any further call', async () => {
        const options = optionsOf({ maxBatches: 2 });
        const runId = await seedPriorAttempt(options, [0, 0, 1]);
        const harness = createHarness({ maxBatches: 2, budgetLimit: 2 });

        const failure = await generationFailureOf(runGeneration(harness.deps));

        expect(failure.code).toBe('budget_insufficient');
        expect(harness.modelCalls).toHaveLength(0);
        expect(await getReservedModelCalls(runDb, runId)).toBe(3);
    });

    it('stops immediately when the run has already spent a cap the plan still fits', async () => {
        const options = optionsOf();
        const runId = await seedPriorAttempt(options, [0, 0, 0, 0]);
        const harness = createHarness({ budgetLimit: 4 });

        const summary = await runGeneration(harness.deps);

        expect(summary.stopReason).toBe('budget_exhausted');
        expect(summary.executedBatches).toBe(0);
        expect(harness.modelCalls).toHaveLength(0);
        expect(await getReservedModelCalls(runDb, runId)).toBe(4);
        expect(harness.entriesFor('model_budget_exhausted')).toHaveLength(1);
        expect((await runRow(runId)).status).toBe('running');
    });
});

/* -------------------------------------------------------------------------- *
 * The work list: the same batches, and the same rows, however often it runs.
 * -------------------------------------------------------------------------- */

describe('the batch work list', () => {
    beforeEach(async () => {
        await truncateFeatureTables();
    });

    it('sizes the category from what the import already supplied, tail included', async () => {
        const harness = createHarness({ batchSize: 74, maxBatches: null });

        const plan = await buildGenerationPlan(harness.deps);

        // 75 candidates at 74 per batch: one full batch and a tail of one.
        expect(plan.aiCandidatesByCategory[CATEGORY]).toBe(75);
        expect(plan.batches.map((batch) => batch.candidateTarget)).toEqual([74, 1]);
        expect(plan.batches.map((batch) => batch.batchKey)).toEqual([batchKeyOf(0), batchKeyOf(1)]);
        expect(plan.executable.estimatedModelCalls).toBe(2 * coveragePlan.modelCallsPerBatch);
    });

    it('subtracts the catalog rows the import already wrote for the category', async () => {
        // The shared factory's default is a published, source-backed USDA food,
        // which is exactly what the import leaves behind; only the category it
        // counts against is this suite's business.
        await makeCatalogFood({
            category: CATEGORY,
            food_state: 'raw',
            food_group: FOOD_GROUP,
            allergen_tags: ['eggs'],
            diet_tags: ['vegetarian'],
        });

        const harness = createHarness({ batchSize: 74, maxBatches: null });

        const plan = await buildGenerationPlan(harness.deps);

        expect(plan.usdaImportedByCategory[CATEGORY]).toBe(1);
        expect(plan.aiCandidatesByCategory[CATEGORY]).toBe(74);
        expect(plan.batches.map((batch) => batch.candidateTarget)).toEqual([74]);
    });

    it('refuses a category the coverage plan does not declare', async () => {
        const harness = createHarness({ categories: ['protein_unicorn'] });

        const failure = await generationFailureOf(runGeneration(harness.deps));

        expect(failure.code).toBe('unknown_category');
        expect(failure.context.category).toBe('protein_unicorn');
        expect(await prisma.catalog_import_runs.count()).toBe(0);
    });

    it('addresses exactly the same batch keys on a second attempt, adding no rows', async () => {
        const failing = createHarness({
            maxBatches: 2,
            respond: (ordinal) => {
                if (ordinal === 2) {
                    throw new OpenRouterError('timeout', 'the vendor did not answer in time');
                }
                return batchPayload();
            },
        });
        await generationFailureOf(runGeneration(failing.deps));

        const keysAfterFirst = await batchKeysInTable();
        const retrying = createHarness({ maxBatches: 2 });

        await runGeneration(retrying.deps);

        expect(keysAfterFirst).toEqual([batchKeyOf(0), batchKeyOf(1)]);
        expect(await batchKeysInTable()).toEqual(keysAfterFirst);
        expect(await prisma.catalog_generation_batches.count()).toBe(2);
    });
});

describe('rerunning a batch converges on one row per source key', () => {
    beforeEach(async () => {
        await truncateFeatureTables();
    });

    /**
     * The first batch writes the candidate and completes; the second batch's
     * call fails, so the run ends unfinished with the row already in place.
     */
    const firstAttempt = async (): Promise<Harness> => {
        const harness = createHarness({
            maxBatches: 2,
            respond: (ordinal) => {
                if (ordinal === 2) {
                    throw new OpenRouterError('empty', 'the vendor returned no completion');
                }
                return batchPayload();
            },
        });

        await generationFailureOf(runGeneration(harness.deps));

        return harness;
    };

    it('derives the AI source key from the category, the normalized name and the state', async () => {
        await firstAttempt();

        const rows = await generatedFoodRows();

        expect(rows).toHaveLength(1);
        expect(rows[0].source_key).toBe(FOOD_SOURCE_KEY);
        expect(rows[0].canonical_name).toBe(FOOD_NAME);
    });

    it('writes an AI estimate for review and never publishes it', async () => {
        await firstAttempt();

        const rows = await generatedFoodRows();

        expect(rows[0].identity_source).toBe('ai_generated');
        expect(rows[0].nutrition_provenance).toBe('ai_estimated');
        expect(rows[0].identity_status).toBe('verified');
        // The allergen list is the model's claim, so `allergen_status` stays
        // unknown and its review flag holds the row out of the catalog until
        // catalog:validate lifts it. Publication is that stage's alone.
        expect(rows[0].allergen_status).toBe('unknown');
        expect(rows[0].publication_status).toBe('quarantined');
        expect(rows[0].publication_status).not.toBe('published');
    });

    it('lets PostgreSQL generate search_vector from the search text the stage wrote', async () => {
        await firstAttempt();

        const [row] = await prisma.$queryRaw<{ search_text: string; search_vector: string }[]>`
            SELECT search_text, search_vector::text AS search_vector
            FROM catalog_foods
            WHERE source_key = ${FOOD_SOURCE_KEY}
        `;

        expect(row.search_text).toContain('poached');
        expect(row.search_vector).toContain('poach');
    });

    it('updates the existing row instead of inserting a second one', async () => {
        await firstAttempt();
        const before = await generatedFoodRows();

        // The retry's remaining batch proposes the identity the first attempt
        // already wrote, which is what the upsert on source_key has to absorb.
        const retrying = createHarness({ maxBatches: 2 });
        const summary = await runGeneration(retrying.deps);

        expect(summary.counts.inserted).toBe(0);
        expect(summary.counts.updated).toBe(1);
        expect(await generatedFoodRows()).toEqual(before);
        expect(await prisma.catalog_foods.count()).toBe(1);
        expect(await prisma.catalog_validation_records.count()).toBe(1);
    });

    it('folds two proposals of one identity inside a batch into a single row', async () => {
        const harness = createHarness({
            respond: () =>
                batchPayload(
                    foodPayload(),
                    foodPayload({ canonicalName: 'poached  chicken egg!', displayName: 'Poached egg' }),
                ),
        });

        const summary = await runGeneration(harness.deps);
        const report = harness.reports[0] as {
            duplicatesRemoved: { generationStage: number; sourceKeys: string[] };
        };

        expect(summary.counts.candidatesProposed).toBe(2);
        expect(summary.counts.inserted).toBe(1);
        expect(await prisma.catalog_foods.count()).toBe(1);
        // Recorded twice because both guards fire: the identity fold reports the
        // proposal it merged, and the already-written guard then refuses to let
        // the second proposal overwrite the row the first one earned.
        expect(summary.counts.duplicatesRemoved).toBe(2);
        expect(report.duplicatesRemoved.generationStage).toBe(2);
        expect(report.duplicatesRemoved.sourceKeys).toContain(FOOD_SOURCE_KEY);
    });

    it('reports a completed stage as already done rather than generating it again', async () => {
        const first = createHarness();
        await runGeneration(first.deps);

        const second = createHarness();
        const summary = await runGeneration(second.deps);

        expect(summary.stopReason).toBe('already_completed');
        expect(summary.executedBatches).toBe(0);
        expect(second.modelCalls).toHaveLength(0);
        expect(await prisma.catalog_foods.count()).toBe(1);
    });
});

/* -------------------------------------------------------------------------- *
 * Refusals: a branded candidate, and one nothing corroborates.
 * -------------------------------------------------------------------------- */

describe('a branded candidate is refused at parse time', () => {
    beforeEach(async () => {
        await truncateFeatureTables();
    });

    const brandedBatch = (): Harness =>
        createHarness({
            respond: () =>
                batchPayload(
                    foodPayload({
                        canonicalName: BRANDED_FOOD_NAME,
                        displayName: BRANDED_FOOD_NAME,
                        aliases: [],
                        foodGroup: 'egg_product',
                        evidenceUrls: [EVIDENCE_URL],
                    }),
                    foodPayload(),
                ),
        });

    it('refuses it before any evidence fetch and before any write', async () => {
        const harness = brandedBatch();

        const summary = await runGeneration(harness.deps);

        expect(summary.counts.candidatesProposed).toBe(2);
        expect(summary.counts.candidatesRefused).toBe(1);
        expect(summary.counts.inserted).toBe(1);
        // A model-proposed manufacturer domain cannot verify a model-proposed
        // product, so the candidate never earns a retrieval attempt.
        expect(harness.evidenceCalls).toHaveLength(1);
        expect(harness.evidenceCalls[0].expectedName).toBe(FOOD_NAME);
        expect((await generatedFoodRows()).map((row) => row.canonical_name)).toEqual([FOOD_NAME]);
    });

    it('counts the refusal in the report and in the batch progress line', async () => {
        const harness = brandedBatch();

        await runGeneration(harness.deps);
        const report = harness.reports[0] as {
            refusedCandidates: { total: number; records: { name: string; reason: string }[] };
        };

        expect(report.refusedCandidates.total).toBe(1);
        expect(report.refusedCandidates.records).toEqual([
            expect.objectContaining({
                name: BRANDED_FOOD_NAME,
                reason: CATALOG_CHECK_NAMES.BRAND_PATTERN_NAME,
            }),
        ]);
        expect(harness.entriesFor('batch_progress')).toEqual([expect.objectContaining({ refused: 1 })]);
    });

    it('asks the model for no brand at all: the schema has no such property', async () => {
        const harness = createHarness();

        await runGeneration(harness.deps);
        const schema = harness.modelCalls[0].schema as {
            schema: {
                properties: {
                    foods: { items: { properties: Record<string, unknown>; required: string[] } };
                };
            };
        };
        const item = schema.schema.properties.foods.items;

        expect(Object.keys(item.properties).filter((name) => /brand/i.test(name))).toEqual([]);
        expect(item.required.filter((name) => /brand/i.test(name))).toEqual([]);
        expect(item.required).toContain('canonicalName');
    });
});

describe('a candidate no evidence corroborates', () => {
    beforeEach(async () => {
        await truncateFeatureTables();
    });

    it('is quarantined, kept out of the published catalog, and does not stop the run', async () => {
        const harness = createHarness({ evidence: uncorroborated });

        const summary = await runGeneration(harness.deps);
        const rows = await generatedFoodRows();

        expect(summary.stopReason).toBe('completed');
        expect(summary.counts.evidenceUnsourced).toBe(1);
        expect(summary.counts.evidenceVerified).toBe(0);
        expect(summary.counts.quarantined).toBe(1);
        expect(summary.counts.candidates).toBe(0);
        expect(rows[0].identity_status).toBe('unsourced');
        expect(rows[0].publication_status).toBe('quarantined');
        expect(
            await prisma.catalog_foods.count({ where: { publication_status: 'published' } }),
        ).toBe(0);
    });

    it('records the refusal reason for the operator report', async () => {
        const harness = createHarness({ evidence: uncorroborated });

        await runGeneration(harness.deps);
        const report = harness.reports[0] as {
            aiEvidence: { verified: number; unsourced: number; refusalsByReason: Record<string, number> };
        };

        expect(report.aiEvidence).toMatchObject({
            verified: 0,
            unsourced: 1,
            refusalsByReason: { host_not_allowlisted: 1 },
        });
    });

    it('stores the retrieval record and the checks in the validation record', async () => {
        const harness = createHarness();

        await runGeneration(harness.deps);
        const record = await prisma.catalog_validation_records.findFirstOrThrow({
            select: {
                identity_source: true,
                identity_status: true,
                nutrition_provenance: true,
                publication_status: true,
                llm_review: true,
                identity_evidence: true,
            },
        });

        expect(record).toMatchObject({
            identity_source: 'ai_generated',
            identity_status: 'verified',
            nutrition_provenance: 'ai_estimated',
            publication_status: 'quarantined',
            // The generating model is not a reviewer of its own output.
            llm_review: null,
        });
        expect(record.identity_evidence).toEqual([
            expect.objectContaining({ finalHost: EVIDENCE_HOST, status: 200 }),
        ]);
    });
});

/* -------------------------------------------------------------------------- *
 * The vendor boundary: no OpenRouter error shape reaches an operator.
 *
 * `OpenRouterErrorKind` is a closed set, and every member is covered, because a
 * member nobody covers is exactly the one that leaks a vendor shape (§9).
 * -------------------------------------------------------------------------- */

describe('a vendor failure surfaces as this stage`s own error', () => {
    beforeEach(async () => {
        await truncateFeatureTables();
    });

    const vendorKinds: readonly [OpenRouterErrorKind, number | undefined][] = [
        ['not_configured', undefined],
        ['http', 502],
        ['empty', undefined],
        ['timeout', undefined],
        ['network', undefined],
        ['unparseable', undefined],
    ];

    it.each(vendorKinds)('wraps a %s failure as model_call_failed', async (kind, status) => {
        const harness = createHarness({
            respond: () => {
                throw new OpenRouterError(kind, `the vendor failed with ${kind}`, status);
            },
        });

        const failure = await generationFailureOf(runGeneration(harness.deps));
        const runId = await currentRunId();

        expect(failure).not.toBeInstanceOf(OpenRouterError);
        expect(failure.code).toBe('model_call_failed');
        expect(failure.context.kind).toBe(kind);
        expect(failure.context.status).toBe(status);
        expect(failure.context.batchKey).toBe(batchKeyOf(0));
        expect(failure.context.category).toBe(CATEGORY);
        // The failure is recorded on both rows, and the reservation stands.
        expect(await batchLedgerRow(batchKeyOf(0))).toMatchObject({
            status: 'failed',
            model_calls_reserved: 1,
            model_calls_used: 1,
        });
        expect((await runRow(runId)).status).toBe('failed');
    });

    it('fails one batch rather than the run when the answer is not a batch of foods', async () => {
        const harness = createHarness({
            maxBatches: 2,
            respond: (ordinal) => (ordinal === 1 ? { note: 'no foods here' } : batchPayload()),
        });

        const summary = await runGeneration(harness.deps);

        expect(summary.stopReason).toBe('completed');
        expect(summary.counts.failedBatches).toBe(1);
        expect(summary.counts.executedBatches).toBe(1);
        // The unusable answer still cost a call, and the batch stays incomplete
        // so a later resume retries it.
        expect(await batchLedgerRow(batchKeyOf(0))).toMatchObject({
            status: 'failed',
            model_calls_reserved: 1,
            model_calls_used: 1,
        });
        expect(harness.entriesFor('batch_response_unusable')).toEqual([
            expect.objectContaining({ code: 'model_response_unusable', batchKey: batchKeyOf(0) }),
        ]);
    });
});

/* -------------------------------------------------------------------------- *
 * What the stage is allowed to say in a log line.
 *
 * The redaction rules themselves belong to `scripts/lib/logger.ts` and are
 * pinned beside the import stage; what is asserted here is what THIS stage puts
 * into a line: the metadata shape, a failure as `safeError`'s two scrubbed
 * fields, and never a credential, a prompt or a model-proposed URL.
 * -------------------------------------------------------------------------- */

describe('the stage`s log lines', () => {
    beforeEach(async () => {
        await truncateFeatureTables();
    });

    it('are one JSON object per line, led by the four metadata fields', async () => {
        const harness = createHarness();

        await runGeneration(harness.deps);

        expect(harness.lines.length).toBeGreaterThan(0);
        for (const entry of harness.entries()) {
            expect(Object.keys(entry).slice(0, 4)).toEqual(['ts', 'level', 'scope', 'event']);
            expect(entry.ts).toBe(FIXED_NOW.toISOString());
            expect(entry.scope).toBe('catalog-generate-ai');
        }
    });

    it('carry a failure as a name and a message, never the error object', async () => {
        const harness = createHarness({
            respond: () => 'OPENROUTER_API_KEY=harness-not-a-real-value {not json',
        });

        await runGeneration(harness.deps);
        const [unusable] = harness.entriesFor('batch_response_unusable');

        expect(Object.keys(unusable.error as Record<string, unknown>)).toEqual(['name', 'message']);
        expect((unusable.error as { name: string }).name).toBe('CatalogGenerationError');
        expect(harness.output()).not.toContain('harness-not-a-real-value');
    });

    it('never carry the prompt, and name an evidence host without its URL', async () => {
        const harness = createHarness();

        await runGeneration(harness.deps);
        const output = harness.output();

        expect(output).not.toContain('GENERIC food preparations');
        expect(output).not.toContain('Foods to propose');
        expect(output).toContain(EVIDENCE_HOST);
        expect(output).not.toContain(EVIDENCE_PATH);
        expect(output).not.toMatch(/bearer\s+\S/i);
        expect(output).not.toMatch(/OPENROUTER_API_KEY=[^*"\s]/);
    });
});

