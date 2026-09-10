// The model-call ledger for the offline catalog pipeline — an operator-scoped
// meter, where src/services/entitlement.service.ts is the request-scoped one.
//
// WHY THIS MODULE EXISTS. Rule backend-architecture §9 requires "meter before
// you spend": entitlement.service.ts consumes a user's daily quota BEFORE the
// LLM call, because a failed call still costs tokens and failures must not
// become free retries. The catalog scripts make the same paid OpenRouter calls
// with no user to meter — catalog-generate-ai.ts generates candidates and
// catalog-validate.ts runs the advisory review — so the rule's ORDER is
// preserved here at operator scope: reserve a call in
// catalog_generation_batches.model_calls_reserved, spend it, record the usage,
// and never release the reservation when the call fails. Agent Action Plan
// §0.10 records this as the sanctioned resolution: ai_usage is per-user and
// request-scoped and cannot express an unattended run, so the ledger moves to
// the batch table while the ordering guarantee stays identical.
//
// THE CAP IS PER RUN, NOT PER CATEGORY AND NOT GLOBAL-ACROSS-RUNS.
// CATALOG_MODEL_CALL_BUDGET is "the hard cap on OpenRouter calls — generation
// and review calls share the one cap — for a single catalog:generate or
// catalog:validate run" (Agent Action Plan §0.4.3). That is why every aggregate
// below is scoped by `run_id` and why reserveModelCall takes `batchKey` from
// its caller rather than deriving it: the two stages share a run's budget and
// each owns its own key format. Re-scoping any query here to all runs, or to
// one category, silently changes what the operator's number means.
//
// WHY THERE IS NO `user_id` IN THESE PREDICATES. Rule §1.5/§5.1 makes every
// Prisma `where` carry the owner key. catalog_generation_batches has no
// `user_id` BY DESIGN — it is shared reference data, and Agent Action Plan
// §0.5.1 records the catalog and recipe tables as the only authenticated reads
// without a tenant predicate. The compensating control is per-process rather
// than per-row: scripts/lib/dbGuard.ts classifies DATABASE_URL and refuses an
// unrecognised origin before Prisma is imported, so an unowned write can only
// land in a database it recognises. Within that boundary the scoping key is
// `run_id` (for every aggregate) or the globally unique `batch_key` (for every
// single-row read and write), and no statement below touches a batch row
// without one of them in its predicate.
//
// WHAT THIS MODULE DOES NOT DO (§1.1). It meters. It never calls OpenRouter,
// never constructs a Prisma client or reaches for the `prisma` singleton, never
// loads a manifest, never judges a catalog candidate, and never owns run
// lifecycle — catalog_import_runs belongs to scripts/lib/checkpoint.ts, which
// this module calls only to mirror its running totals. `db`, `env`, the budget
// limit and the logger are all injected, which is what lets the script suites
// under src/__tests__/scripts drive budget exhaustion and resume without a
// vendor or a fixed environment (§11 — Jest's `roots` is <rootDir>/src, so no
// test file can live beside this one).
//
// TYPECHECKING NOTE: the type-only chain through ./checkpoint resolves to
// Prisma's generated client, which .gitignore excludes and which CI and the
// Docker build regenerate. `npx prisma generate` must therefore have run
// against the current prisma/schema.prisma before this file typechecks.

import { recordCounts } from './checkpoint';
import type { CatalogRunDb } from './checkpoint';
import { describeMissingEnv } from './logger';
import type { ScriptLogger } from './logger';

// Matches `defaultBatchSize` in data/meal-planning/coverage-plan.v1.json. The
// environment variable is the override and the plan file is the documented
// default, so the two can only disagree deliberately: change the plan file and
// this constant together, never one alone.
export const DEFAULT_CATALOG_BATCH_SIZE = 25;

const MODEL_CALL_BUDGET_ENV_VAR = 'CATALOG_MODEL_CALL_BUDGET';
const BATCH_SIZE_ENV_VAR = 'CATALOG_BATCH_SIZE';

// Zero-padded so batch keys sort lexicographically in a log, a report or an
// `ORDER BY batch_key`. Four digits covers the coverage plan's largest category
// (prepared_meal, 70 batches) by a wide margin; an index beyond the width still
// produces a unique key and only loses the sort order.
const BATCH_INDEX_WIDTH = 4;

// The batch lifecycle ('pending' -> 'generated' -> 'validated' | 'failed', per
// the column comment in prisma/schema.prisma) belongs to the generating script.
// This module only ever creates a row in its initial state, because a
// reservation is the first thing that happens to a batch; it never advances the
// status afterwards.
const INITIAL_BATCH_STATUS = 'pending';

export type ModelBudgetCode = 'budget_misconfigured' | 'budget_insufficient' | 'budget_exhausted' | 'batch_not_found';

// Follows the DailyQuotaError template in src/services/entitlement.service.ts
// (§8): a named class carrying the numbers the caller needs rather than a
// string, so catalog-generate-ai.ts can distinguish a misconfigured environment
// from a plan that cannot fit from a run that has spent its budget, and report
// each with its figures.
//
// `reserved` is strictly "reservations already recorded against this run", so
// it is null for the two codes where nothing has been reserved yet
// (budget_misconfigured, budget_insufficient) and for batch_not_found. Nothing
// is lost: a caller hitting budget_insufficient already holds the BatchPlan it
// passed in.
export class ModelBudgetError extends Error {
    constructor(
        public readonly code: ModelBudgetCode,
        message: string,
        public readonly reserved: number | null = null,
        public readonly limit: number | null = null,
    ) {
        super(message);
        this.name = 'ModelBudgetError';
    }
}

// ---------------------------------------------------------------------------
// Internal guards. The exported pure functions below are the ones worth
// pinning (§7.1); these exist so a malformed number can never reach the
// arithmetic or a Prisma increment, where it would either poison a total or
// fail the statement.
//
// Only the PARSED number is ever echoed, never the caller's raw input — the
// same rule rateLimiter.ts states for its own config message, because a
// misplaced paste can put a credential on a line that reaches a terminal, a CI
// log or a committed report.
// ---------------------------------------------------------------------------

const describeNumber = (value: number): string => (Number.isFinite(value) ? `${value}` : 'not a number');

const requirePositiveInteger = (value: number, label: string): number => {
    if (!Number.isInteger(value) || value <= 0) {
        throw new ModelBudgetError(
            'budget_misconfigured',
            `${label} must be a positive integer (got ${describeNumber(value)})`,
        );
    }
    return value;
};

const requireNonNegativeInteger = (value: number, label: string): number => {
    if (!Number.isInteger(value) || value < 0) {
        throw new ModelBudgetError(
            'budget_misconfigured',
            `${label} must be a non-negative integer (got ${describeNumber(value)})`,
        );
    }
    return value;
};

// ---------------------------------------------------------------------------
// Configuration. These two accessors are the ONLY environment reads in this
// file, and they happen at the boundary: every function below receives its
// numbers as arguments, because §1.6/§5 forbids branching on process.env inside
// the flow. `env` is a parameter so the accessors are testable without mutating
// the process (§11).
// ---------------------------------------------------------------------------

/**
 * Resolves the hard per-run cap on paid model calls — the only place
 * `CATALOG_MODEL_CALL_BUDGET` is read.
 *
 * It has NO DEFAULT, deliberately parting company with
 * `entitlement.service.ts`'s `getDailyQuota()`, which silently falls back to 5.
 * That asymmetry is the point: a missing or mistyped per-user QUOTA degrades
 * gracefully and affects one caller's next request, whereas a missing SPEND CAP
 * on an unattended run that makes thousands of paid vendor calls has no safe
 * fallback to choose — any number this module invented would be a spending
 * decision it is not entitled to make. Agent Action Plan §0.4.3 therefore
 * specifies a "required positive integer" whose absence fails the run closed at
 * startup, and .env.example documents it the same way.
 */
export const getCatalogModelCallBudget = (env: NodeJS.ProcessEnv = process.env): number => {
    const raw = env[MODEL_CALL_BUDGET_ENV_VAR];

    // Blank is treated as absent rather than as 0: an empty assignment in a
    // .env file is an unfinished edit, and `Number('')` is 0, which would
    // otherwise read as a deliberate cap of zero.
    if (raw === undefined || raw.trim().length === 0) {
        throw new ModelBudgetError(
            'budget_misconfigured',
            `${describeMissingEnv(MODEL_CALL_BUDGET_ENV_VAR)} — it is required, with no default, ` +
                'because an offline run makes paid model calls.',
        );
    }

    const parsed = Number(raw.trim());
    if (!Number.isInteger(parsed) || parsed <= 0) {
        throw new ModelBudgetError(
            'budget_misconfigured',
            `${MODEL_CALL_BUDGET_ENV_VAR} must be a positive integer (got ${describeNumber(parsed)})`,
        );
    }

    return parsed;
};

/**
 * Resolves the number of candidates per generation batch — the only place
 * `CATALOG_BATCH_SIZE` is read.
 *
 * Unlike the budget above this one does have a default, because
 * `DEFAULT_CATALOG_BATCH_SIZE` mirrors the coverage plan's own
 * `defaultBatchSize`: falling back to it reproduces the reviewed plan rather
 * than inventing a policy. A value that is present but unusable still throws,
 * so a typo cannot quietly reshape every batch key in the run and turn a resume
 * into a restart.
 */
export const getCatalogBatchSize = (env: NodeJS.ProcessEnv = process.env): number => {
    const raw = env[BATCH_SIZE_ENV_VAR];

    if (raw === undefined || raw.trim().length === 0) {
        return DEFAULT_CATALOG_BATCH_SIZE;
    }

    const parsed = Number(raw.trim());
    if (!Number.isInteger(parsed) || parsed <= 0) {
        throw new ModelBudgetError(
            'budget_misconfigured',
            `${BATCH_SIZE_ENV_VAR} must be a positive integer (got ${describeNumber(parsed)})`,
        );
    }

    return parsed;
};

// ---------------------------------------------------------------------------
// Pure decisions (§1.2). Exported so the unit suite under src/__tests__ can pin
// them with no database. Each holds a rule that costs real money to get wrong:
// an off-by-one in the Math.ceil below under-orders batches, a hard-coded
// calls-per-batch factor makes a plan revision unreviewable, and a `>=` where
// the cap check wants `>` refuses a run that exactly fits its budget.
// ---------------------------------------------------------------------------

export interface BatchPlanInput {
    /**
     * Per category, the candidates AI generation still has to produce — the
     * coverage plan's `candidateVolume` minus what the USDA import already
     * supplied. A category the import covered completely is 0, not absent.
     */
    aiCandidatesByCategory: Readonly<Record<string, number>>;
    batchSize: number;
    /**
     * Model calls one batch costs. This is data, not a constant: it comes from
     * `modelCallsPerBatch` in coverage-plan.v1.json (currently 2 — one
     * generation call and one advisory review call), so a plan revision that
     * adds a third call changes one JSON field and no code here.
     */
    modelCallsPerBatch: number;
}

export interface BatchPlan {
    batchesByCategory: Readonly<Record<string, number>>;
    totalBatches: number;
    estimatedModelCalls: number;
}

/**
 * Sizes a generation run: how many batches each category needs and what that
 * costs in model calls.
 *
 * THE TAIL BATCH, because it is the part a reader doubts: the final batch of a
 * category carries the remainder rather than being padded or dropped, so
 * protein_plant's 438 candidates at a batch size of 25 is 18 batches — 17 full
 * ones and a tail of 13 (17 x 25 + 13 = 438). Rounding down instead would leave
 * 13 candidates ungenerated and quietly miss the category's published target;
 * the coverage plan's tail-13 categories (protein_plant, nut_seed,
 * dairy_alternative, legume, oil_fat) exist precisely because of this.
 */
export const planBatches = (input: BatchPlanInput): BatchPlan => {
    const batchSize = requirePositiveInteger(input.batchSize, 'batchSize');
    const modelCallsPerBatch = requirePositiveInteger(input.modelCallsPerBatch, 'modelCallsPerBatch');

    const candidates = input.aiCandidatesByCategory;
    const batchesByCategory: Record<string, number> = {};
    let totalBatches = 0;

    // Guarded rather than trusted, like logger.ts's and checkpoint.ts's own
    // inputs: this map is loaded from a JSON file on disk, so its declared type
    // does not bind what actually arrives.
    if (candidates !== null && typeof candidates === 'object') {
        for (const category of Object.keys(candidates)) {
            const aiCandidates = candidates[category];

            // A count that is not a finite number cannot be interpreted at all,
            // and letting one through would make `totalBatches` NaN and the
            // startup estimate meaningless. That is a malformed coverage plan,
            // so it fails the run closed here rather than surfacing later as a
            // mid-run surprise.
            if (typeof aiCandidates !== 'number' || !Number.isFinite(aiCandidates)) {
                throw new ModelBudgetError(
                    'budget_misconfigured',
                    `aiCandidatesByCategory.${category} must be a finite number`,
                );
            }

            // Zero or less means the USDA import already covered the category,
            // so it needs no generation. The key is kept with a 0 rather than
            // omitted, so the run report shows the category was considered.
            const batches = aiCandidates > 0 ? Math.ceil(aiCandidates / batchSize) : 0;

            batchesByCategory[category] = batches;
            totalBatches += batches;
        }
    }

    return { batchesByCategory, totalBatches, estimatedModelCalls: totalBatches * modelCallsPerBatch };
};

// `padStart` is ES2017 and tsconfig.json targets es2016, so it only typechecks
// here by accident of @types/node referencing a newer lib. `repeat` is ES2015
// and needs no such luck.
const padBatchIndex = (batchIndex: number): string => {
    const digits = `${batchIndex}`;
    return digits.length >= BATCH_INDEX_WIDTH
        ? digits
        : `${'0'.repeat(BATCH_INDEX_WIDTH - digits.length)}${digits}`;
};

/**
 * Builds the generation batch key documented by coverage-plan.v1.json:
 * `<coveragePlanVersion>:<category>:<zero-padded batchIndex>`. Addressing the
 * same batch by the same key is what makes a rerun a no-op and a resume
 * possible.
 *
 * `batch_key` is GLOBALLY unique (prisma/schema.prisma), not unique per run, so
 * any other stage sharing this ledger must supply keys that cannot collide with
 * generation's — catalog-validate.ts's advisory review owns its own format, and
 * reserveModelCall deliberately accepts whatever key its caller passes rather
 * than building one, so this function never becomes a bottleneck on that.
 */
export const batchKeyFor = (coveragePlanVersion: string, category: string, batchIndex: number): string => {
    const index = requireNonNegativeInteger(batchIndex, 'batchIndex');
    return `${coveragePlanVersion}:${category}:${padBatchIndex(index)}`;
};

/**
 * The startup gate: fails a run closed before its first vendor call when the
 * plan cannot fit the configured cap.
 *
 * The estimate is logged FIRST and unconditionally, whether or not it fits,
 * because an operator starting a long unattended run needs to see what it
 * intends to spend even on the happy path.
 */
export const assertModelCallBudget = (plan: BatchPlan, budgetLimit: number, logger?: ScriptLogger): void => {
    const limit = requirePositiveInteger(budgetLimit, 'budgetLimit');

    // Re-derived from the plan rather than taken as an argument, so the logged
    // factor is necessarily the one the estimate was actually computed with and
    // cannot drift from it. An empty plan has no factor to report.
    const modelCallsPerBatch = plan.totalBatches > 0 ? plan.estimatedModelCalls / plan.totalBatches : 0;

    logger?.info('model_budget_estimate', {
        totalBatches: plan.totalBatches,
        modelCallsPerBatch,
        estimatedModelCalls: plan.estimatedModelCalls,
        budgetLimit: limit,
    });

    // `>` and not `>=`: a plan that needs exactly its budget fits.
    if (plan.estimatedModelCalls > limit) {
        throw new ModelBudgetError(
            'budget_insufficient',
            `This run needs ${plan.estimatedModelCalls} model call(s) for ${plan.totalBatches} batch(es) but ` +
                `${MODEL_CALL_BUDGET_ENV_VAR} allows ${limit}. Raise ${MODEL_CALL_BUDGET_ENV_VAR} to at least ` +
                `${plan.estimatedModelCalls}, or reduce the candidate volume in the coverage plan.`,
            null,
            limit,
        );
    }
};

// ---------------------------------------------------------------------------
// The ledger itself (§1.2 — these orchestrate I/O; every decision they need is
// above). Scoped by `run_id` or the unique `batch_key`, never by row id alone.
// ---------------------------------------------------------------------------

/**
 * Calls reserved so far against this run, summed across every batch it owns —
 * generation's and the review's alike, because they share one cap.
 *
 * THIS AGGREGATE IS AUTHORITATIVE. The same totals are mirrored into
 * catalog_import_runs.counts for the reports, but that mirror is a diagnostic:
 * it is a read-modify-write on a JSONB column (see checkpoint.ts's mergeCounts)
 * and a process killed mid-write can leave it behind. Reading the sum instead
 * is what lets an interrupted run resume against its real remaining budget
 * rather than trusting a counter that may have died halfway.
 */
export const getReservedModelCalls = async (db: CatalogRunDb, runId: string): Promise<number> => {
    const aggregate = await db.catalog_generation_batches.aggregate({
        _sum: { model_calls_reserved: true },
        where: { run_id: runId },
    });

    // SUM over zero rows is SQL NULL, which is the ordinary state of a run
    // before its first reservation.
    const reserved = aggregate._sum.model_calls_reserved;
    return typeof reserved === 'number' && Number.isFinite(reserved) ? reserved : 0;
};

/**
 * Calls this run may still make. Floored at 0 so an over-reserved run (a cap
 * lowered between two runs of the same pipeline) reports "none left" rather
 * than a negative allowance a caller might treat as headroom.
 */
export const getRemainingModelCalls = async (
    db: CatalogRunDb,
    runId: string,
    budgetLimit: number,
): Promise<number> => {
    const limit = requirePositiveInteger(budgetLimit, 'budgetLimit');
    const reserved = await getReservedModelCalls(db, runId);
    return Math.max(0, limit - reserved);
};

/**
 * Reserves one paid model call. Call this IMMEDIATELY BEFORE `callOpenRouter`,
 * never after — that ordering is the rule this module exists to enforce (§9).
 *
 * Throws `budget_exhausted` when the run has spent its cap, before any
 * increment and before the vendor call, so the caller's stop reason is a value
 * rather than a surprise bill.
 */
export const reserveModelCall = async (
    db: CatalogRunDb,
    input: {
        runId: string;
        batchKey: string;
        category: string;
        model: string;
        promptVersion: string;
        budgetLimit: number;
        logger?: ScriptLogger;
    },
): Promise<{ reserved: number; remaining: number }> => {
    const limit = requirePositiveInteger(input.budgetLimit, 'budgetLimit');
    const reserved = await getReservedModelCalls(db, input.runId);

    // `>=`, unlike the `>` in assertModelCallBudget: there the question is
    // whether N more calls fit, here it is whether one more does.
    if (reserved >= limit) {
        input.logger?.warn('model_budget_exhausted', {
            runId: input.runId,
            batchKey: input.batchKey,
            reserved,
            limit,
        });
        throw new ModelBudgetError(
            'budget_exhausted',
            `${MODEL_CALL_BUDGET_ENV_VAR} of ${limit} model call(s) is exhausted for this run ` +
                `(${reserved} already reserved), so no further model call may be made.`,
            reserved,
            limit,
        );
    }

    // CHECK-THEN-INCREMENT IS SAFE HERE, AND DELIBERATELY UNLOCKED. One script
    // process owns a run from end to end and works through its batches
    // sequentially — a run is resumed and continued, never shared — so this
    // module has exactly one writer per run and there is no interleaving to
    // lose. Do not "fix" this with an advisory lock or a locking read: the race
    // it would guard against cannot occur, and the lock would serialise a
    // multi-hour import against nothing. If a future stage ever reserves
    // concurrently against one run, that needs a locking read, not a comment.
    //
    // The increment itself is still Prisma's atomic `{increment: 1}` — the same
    // idiom entitlement.service.ts uses on ai_usage.count — so the counter is
    // never computed in application code from a value that could be stale.
    await db.catalog_generation_batches.upsert({
        where: { batch_key: input.batchKey },
        create: {
            run_id: input.runId,
            batch_key: input.batchKey,
            category: input.category,
            model: input.model,
            prompt_version: input.promptVersion,
            status: INITIAL_BATCH_STATUS,
            model_calls_reserved: 1,
            model_calls_used: 0,
            tokens_used: 0,
        },
        update: { model_calls_reserved: { increment: 1 } },
    });

    // Mirrored for the reports only: catalog-generate-ai.ts reads these keys
    // back into the `modelSpend` block of
    // data/meal-planning/reports/latest/import-report.json, and catalog-report.ts
    // reads them again, so `modelCallsReserved`, `modelCallsUsed` and
    // `tokensUsed` are a contract with those two scripts and must keep their
    // names. This runs AFTER the authoritative write, which is the order that
    // matters: if the mirror fails, the reservation still stands and the budget
    // stays enforceable, because the aggregate above is what enforces it.
    await recordCounts(db, input.runId, { modelCallsReserved: 1 });

    const reservedAfter = reserved + 1;

    // Debug, not info: a full generation run reserves on the order of a
    // thousand calls, and the two events an operator must see are the startup
    // estimate and the per-call usage record.
    input.logger?.debug('model_call_reserved', {
        runId: input.runId,
        batchKey: input.batchKey,
        category: input.category,
        reserved: reservedAfter,
        remaining: limit - reservedAfter,
    });

    // A crash between here and the vendor call leaves the reservation standing.
    // That is the intended direction: the run has lost one call's worth of
    // budget it may not have spent, which is conservative, where the opposite
    // error would let a retry loop spend without limit.
    return { reserved: reservedAfter, remaining: limit - reservedAfter };
};

// Token counts arrive from a vendor response body, so they are guarded before
// reaching an Int column: a fractional increment would fail the statement and a
// non-finite one would poison the total irrecoverably. A negative count is
// nonsense and reads as "unknown".
const normalizeTokensUsed = (tokensUsed?: number): number => {
    if (typeof tokensUsed !== 'number' || !Number.isFinite(tokensUsed) || tokensUsed <= 0) {
        return 0;
    }
    return Math.round(tokensUsed);
};

/**
 * Records that a reserved model call has returned. Call this AFTER every
 * `callOpenRouter`, on success AND on failure.
 *
 * `model_calls_used` is incremented either way, because the vendor was called
 * either way, and `model_calls_reserved` IS NEVER DECREMENTED. That is the
 * whole point of the rule: a failed call still spends tokens, so releasing its
 * reservation would make failures free retries and the cap unenforceable — the
 * exact reasoning entitlement.service.ts's header gives for consuming quota
 * before the call. `succeeded` therefore changes nothing in the arithmetic; it
 * records the caller's outcome in the log, where the two counters diverging is
 * the signal an operator reads.
 */
export const recordModelCallUsage = async (
    db: CatalogRunDb,
    input: { batchKey: string; succeeded: boolean; tokensUsed?: number; logger?: ScriptLogger },
): Promise<void> => {
    const tokensUsed = normalizeTokensUsed(input.tokensUsed);

    // Read first for two reasons: the run id is needed for the mirror below,
    // and a missing row has to be distinguishable. Racing this read is not a
    // concern — a batch row is never deleted mid-run, and the increments below
    // are atomic regardless.
    const batch = await db.catalog_generation_batches.findUnique({
        where: { batch_key: input.batchKey },
        select: { run_id: true },
    });

    // Usage recorded against a batch that was never reserved means a caller
    // spent without metering — the one bug this module exists to prevent — so
    // it is surfaced loudly rather than swallowed (§8).
    if (!batch) {
        throw new ModelBudgetError(
            'batch_not_found',
            `No generation batch is reserved under batch key ${input.batchKey}: ` +
                'reserveModelCall must run before recordModelCallUsage.',
        );
    }

    await db.catalog_generation_batches.update({
        where: { batch_key: input.batchKey },
        data: {
            model_calls_used: { increment: 1 },
            tokens_used: { increment: tokensUsed },
        },
    });

    await recordCounts(db, batch.run_id, { modelCallsUsed: 1, tokensUsed });

    // Never the prompt, the completion, the API key or a caught error object —
    // logger.ts's safeError is the sanctioned way to reference a failure, and
    // the caller owns that reporting. This line carries counters only.
    input.logger?.info('model_call_recorded', {
        batchKey: input.batchKey,
        succeeded: input.succeeded,
        tokensUsed,
    });
};
