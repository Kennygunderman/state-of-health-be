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
// `run_id`: every aggregate is scoped by it alone, and every single-row write
// pairs it with `batch_key` (`where: { batch_key, run_id }`). `batch_key` on its
// own is UNIQUE (prisma/schema.prisma) but is NOT a sufficient scope: it is
// deliberately stable across runs (see batchKeyFor), so it identifies a batch
// while saying nothing about whose ledger the row is, and charging a reservation
// to whatever run happens to own it would corrupt that run's totals while
// leaving the reserving run's aggregate — the very sum that enforces the cap —
// at zero. No statement below touches a batch row without `run_id` in its
// predicate, except the two failure-path reads that address the key alone in
// order to name the run that does own it.
//
// The row this module inserts belongs to a run it does not own, so before any
// insert it asks checkpoint.ts's requireOpenRun to prove, under a row lock, that
// the run exists and is still open. That check is what keeps a bad run id a
// typed CheckpointError instead of PostgreSQL's foreign-key violation surfacing
// as a raw Prisma error nobody may pattern-match (§9), and what stops a
// reservation being appended to a settled run's finished ledger.
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
// TYPECHECKING NOTE: the type-only chain through ./checkpoint, and the one
// type-only import below, resolve to Prisma's generated client, which
// .gitignore excludes and which CI and the Docker build regenerate.
// `npx prisma generate` must therefore have run against the current
// prisma/schema.prisma before this file typechecks.

import { recordCounts, requireOpenRun } from './checkpoint';
import type { CatalogRunDb } from './checkpoint';
import { describeMissingEnv } from './logger';
import type { ScriptLogger } from './logger';
// Type-only, and the only direct reference to the generated client anywhere in
// this file: the reservation below needs to tell a full client apart from a
// transaction client (see transactionRunnerOf). Nothing here is imported at
// runtime, so this module still constructs no client and loads no engine.
import type { PrismaClient } from '../../src/generated/prisma';

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

export type ModelBudgetCode =
    | 'budget_misconfigured'
    | 'budget_insufficient'
    | 'budget_exhausted'
    | 'batch_not_found'
    | 'batch_run_mismatch';

// Follows the DailyQuotaError template in src/services/entitlement.service.ts
// (§8): a named class carrying the numbers the caller needs rather than a
// string, so catalog-generate-ai.ts can distinguish a misconfigured environment
// from a plan that cannot fit from a run that has spent its budget, and report
// each with its figures.
//
// `batch_not_found` and `batch_run_mismatch` are deliberately separate codes
// because they are different caller mistakes with different fixes. The first is
// "nothing was ever reserved under this key", i.e. a caller spent without
// metering. The second is "the key exists, but the row belongs to another run",
// which happens either because a stage was launched over a coverage plan an
// earlier run already worked, or because reserveModelCall and
// recordModelCallUsage were called with different `runId`s for one model call;
// both messages name the owning run, and the remedy is to continue that run
// rather than to charge this one. Continuing it is a real option rather than
// advice: checkpoint.ts's openOrResumeRun resumes an interrupted run, retries a
// failed one on the same row, and reports a succeeded one as already complete,
// so the run that owns a batch key is always reachable.
//
// Neither code covers a run id that does not exist or is already closed. That is
// checkpoint.ts's domain and it answers with its own typed CheckpointError
// ('run_not_found' / 'run_not_open') before this module inserts anything — see
// the header and claimModelCallReservation.
//
// `reserved` is strictly "reservations already recorded against this run", so
// it is null for the two codes where nothing has been reserved yet
// (budget_misconfigured, budget_insufficient) and for the two batch-identity
// codes. Nothing is lost: a caller hitting budget_insufficient already holds
// the BatchPlan it passed in.
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

/**
 * What an environment value turned out to be when read as a decimal integer.
 * On `not_decimal`, `reads` is whatever `Number()` made of it — `NaN` or an
 * infinity when it could not be coerced at all.
 */
type DecimalIntegerRead =
    | { kind: 'ok'; value: number }
    | { kind: 'not_decimal'; reads: number }
    | { kind: 'not_exact'; digits: number };

/**
 * Reads an environment value as a decimal integer, or reports why it is not
 * one. Ranges are the caller's business; this decides only whether a number was
 * written at all, and whether the one written is the one that would be spent
 * against.
 *
 * `Number()` implements the JavaScript numeric-literal grammar, not a decimal
 * reader, so on its own it accepts forms no operator means by a count of paid
 * calls: `0x10` becomes 16, `1e3` becomes 1000, `+7` becomes 7, `8.` becomes 8,
 * and because `String.prototype.trim` removes U+00A0 a non-breaking space
 * pasted before a digit disappears silently. Each of those would become the
 * hard spend cap for an unattended run — a cap nobody chose, which is exactly
 * the decision this module is not entitled to make on an operator's behalf.
 * `Number()` also rounds: `Number('9007199254740993')` is 9007199254740992,
 * which passes `Number.isInteger` and every range check while no longer being
 * the value that was typed. So the digits are checked before the number is
 * believed, and a magnitude that cannot be represented exactly is refused
 * rather than rounded — the reservation ledger counts single calls, and a cap
 * it cannot represent exactly is a cap it cannot enforce exactly.
 *
 * `rateLimiter.ts` reads `USDA_IMPORT_RATE_LIMIT_PER_HOUR` under this same
 * rule. The rule is stated once per module rather than shared from a third file
 * because each module maps the outcome onto its own error class, and neither
 * may import the other: this one never calls a vendor, and that one touches no
 * database.
 */
const readDecimalInteger = (raw: string): DecimalIntegerRead => {
    // Only ASCII whitespace is stripped, deliberately NOT `String.trim()`:
    // trim also removes U+00A0, U+FEFF and the other Unicode space
    // separators, so a non-breaking space or a byte-order mark pasted in front
    // of a digit would vanish here and the value would be accepted as though it
    // had been typed cleanly. An invisible character in a .env line is exactly
    // what to fail loudly on — it survives later edits, defeats a grep for the
    // value, and any other reader of the same file (a shell `export`, a
    // compose file, a secrets manager) may well disagree about it.
    const trimmed = raw.replace(/^[ \t\n\r\v\f]+/, '').replace(/[ \t\n\r\v\f]+$/, '');

    if (!/^[0-9]+$/.test(trimmed)) {
        // What `Number()` would have made of it is the useful half of the
        // report — it is the cap the run would otherwise have enforced —
        // whereas the raw string is never echoed: a misplaced paste can put a
        // credential on a line that reaches terminals, CI logs and committed
        // reports.
        return { kind: 'not_decimal', reads: Number(trimmed) };
    }

    const value = Number(trimmed);
    if (!Number.isSafeInteger(value)) {
        // Digits only by now, so the only way here is a magnitude past 2^53-1,
        // where the nearest representable double is a different number. The
        // digit count says how far out of range it is without echoing either
        // the raw text or the misleading rounded value.
        return { kind: 'not_exact', digits: trimmed.replace(/^0+(?=[0-9])/, '').length };
    }

    return { kind: 'ok', value };
};

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

/**
 * Reads one environment variable that must be a positive integer, phrasing
 * every rejection as a `budget_misconfigured` startup failure. Whether absence
 * is allowed is the caller's decision — one of these variables is required and
 * the other has a reviewed default — so this is only reached with a value
 * present.
 */
const requirePositiveIntegerEnv = (raw: string, label: string): number => {
    const read = readDecimalInteger(raw);

    if (read.kind === 'not_decimal') {
        throw new ModelBudgetError(
            'budget_misconfigured',
            `${label} must be decimal digits only, with no sign, decimal point, exponent or hex prefix ` +
                `(got ${describeNumber(read.reads)})`,
        );
    }

    if (read.kind === 'not_exact') {
        throw new ModelBudgetError(
            'budget_misconfigured',
            `${label} is too large to be read exactly: ${read.digits} digits exceeds the largest safe ` +
                `integer ${Number.MAX_SAFE_INTEGER}`,
        );
    }

    // Digits only by now, so 0 is the only value left that can fail, and it
    // fails with the range message this variable has always used: a cap of zero
    // is a range error, not a notation one.
    return requirePositiveInteger(read.value, label);
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

    return requirePositiveIntegerEnv(raw, MODEL_CALL_BUDGET_ENV_VAR);
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

    return requirePositiveIntegerEnv(raw, BATCH_SIZE_ENV_VAR);
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

    // Prototype-free on purpose — do not "simplify" this back to `{}`. The
    // coverage plan is JSON parsed from disk, and JSON.parse creates a literal
    // `__proto__` key as an ordinary own property. `Object.keys` enumerates it
    // and `candidates['__proto__']` reads its own value correctly, so the loop
    // below counts it into `totalBatches`; but assigning it on a plain object
    // reaches Object.prototype's setter, which takes an object or null and
    // silently drops a number. The category would then be counted in the
    // estimate and missing from the per-category plan, leaving the two halves
    // of the same return value disagreeing about how much a run will cost.
    const batchesByCategory: Record<string, number> = Object.create(null) as Record<string, number>;
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
 * same batch by the same key is what lets an interrupted or retried run pick the
 * batch up exactly where it stopped; catalog data stays idempotent through the
 * pipeline's own upserts (`source_key` for foods, `slug` for recipes), never
 * through this ledger.
 *
 * `batch_key` is UNIQUE ACROSS THE TABLE (prisma/schema.prisma), not per run, so
 * any other stage sharing this ledger must supply keys that cannot collide with
 * generation's — catalog-validate.ts's advisory review owns its own format, and
 * reserveModelCall deliberately accepts whatever key its caller passes rather
 * than building one, so this function never becomes a bottleneck on that.
 *
 * BECAUSE the key is both unique and stable across runs, it cannot be used on
 * its own to address a run's ledger row: a key produced while working the same
 * coverage plan again resolves to the row the FIRST run created. Every statement
 * in the ledger below therefore pairs the key with `run_id`, and a key whose row
 * belongs to another run is refused with `batch_run_mismatch` rather than
 * silently charged to that run. What makes that refusal actionable is the run
 * lifecycle: checkpoint.ts's openOrResumeRun resumes an interrupted run, retries
 * a failed one on the same row (so its batch keys stay addressable and its spent
 * budget is not forgiven) and reports a succeeded one as already complete
 * without writing to it. A genuinely new set of batches needs a new
 * coveragePlanVersion, which yields keys of its own.
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
// above). Every aggregate is scoped by `run_id` and every write by `run_id` and
// `batch_key` together, never by the key alone and never by row id.
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

// A Prisma transaction client is exactly the client with $transaction removed
// (Prisma's ITXClientDenyList), so its absence is a reliable probe for "the
// caller already owns a transaction" — the same probe checkpoint.ts uses for
// recordCounts. Opening a transaction inside the caller's would nest, which
// Prisma does not support.
const transactionRunnerOf = (db: CatalogRunDb): PrismaClient | null => {
    const candidate = db as PrismaClient;
    return typeof candidate.$transaction === 'function' ? candidate : null;
};

// The per-run budget lock. One string parameter, passed as a bound parameter
// rather than interpolated, and $executeRaw rather than $queryRaw because
// pg_advisory_xact_lock returns `void`, which Prisma cannot deserialise into a
// result row (P2010).
//
// This mirrors the per-user `pg_advisory_xact_lock(hashtext('meal-planning:' ||
// userId))` idiom the Agent Action Plan specifies for every mutating
// meal-planning transaction; the key is namespaced so the two lock spaces
// cannot collide. Transaction-scoped, so it is released by the commit or the
// rollback and cannot be leaked by a killed script.
const lockRunBudget = async (db: CatalogRunDb, runId: string): Promise<void> => {
    const lockKey = `catalog-budget:${runId}`;
    await db.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`;
};

// One message for both ledger paths, so a reservation and a usage record cannot
// describe the same operator mistake in two different ways. It names BOTH runs —
// the one that owns the row and the one that was refused — because "that key is
// taken" on its own would leave the operator guessing which run to look at, and
// it states the remedy, which the run lifecycle makes reachable: continuing the
// owning run is what addresses these keys again (checkpoint.ts's
// openOrResumeRun resumes a running one, retries a failed one on the same row,
// and reports a succeeded one as complete), and a genuinely new set of batches
// needs a new coveragePlanVersion.
const batchRunMismatchError = (batchKey: string, ownerRunId: string, runId: string): ModelBudgetError =>
    new ModelBudgetError(
        'batch_run_mismatch',
        `Batch key ${batchKey} belongs to run ${ownerRunId}, so run ${runId} may not reserve or record ` +
            'against it: batch keys are unique across the ledger and stable across runs. Continue run ' +
            `${ownerRunId} instead of working this coverage plan under a second run, or publish a new ` +
            'coveragePlanVersion so this run gets batch keys of its own.',
    );

// Records one reservation against the batch row THIS RUN owns, creating that
// row when the run has not reserved under the key yet.
//
// Why this is not an upsert on `batch_key`: the key is stable across runs (see
// batchKeyFor), so an upsert keyed on it alone takes its update branch on a row
// a DIFFERENT run created — growing that run's `model_calls_reserved` while the
// aggregate this module enforces the cap with, `SUM(model_calls_reserved) WHERE
// run_id = <this run>`, stays at zero and the cap never binds. The predicate
// therefore carries `run_id` as well, and the three outcomes are distinct:
//
//   1. updateMany matched -> the row is this run's and the atomic increment
//      landed. `batch_key` is UNIQUE, so a match is always exactly one row.
//   2. nothing matched -> either no row exists under the key, or one exists
//      under another run. createMany with skipDuplicates tells the two apart
//      without reading: inserting 1 row means we created this run's row
//      (reserved = 1); inserting 0 means the key was taken. The insert cannot
//      fail for a missing parent run, because requireOpenRun has already proved
//      under a row lock that the run exists and is open.
//   3. still nothing after one retry of the run-bound update -> the row belongs
//      to another run, which is an operator mistake, not a race, so it throws
//      `batch_run_mismatch` naming the run that owns it. The owner is read on
//      this failure path only, and `batch_key` being unique means that read
//      returns the one true owner rather than an arbitrary candidate.
//
// The retry between 2 and 3 exists because "the key was taken" can also mean a
// writer for THIS run created the row in the window between our update and our
// insert — possible for a caller that reserves under a transaction whose budget
// lock is held elsewhere — and that case must reserve, not fail.
//
// skipDuplicates rather than catching a unique-violation on purpose: §9 forbids
// pattern-matching a vendor's error shape, and matching Prisma's P2002 would
// also force a runtime import of the generated client this module never makes.
const bindReservationToRun = async (
    db: CatalogRunDb,
    input: { runId: string; batchKey: string; category: string; model: string; promptVersion: string },
): Promise<void> => {
    const claimed = await db.catalog_generation_batches.updateMany({
        where: { batch_key: input.batchKey, run_id: input.runId },
        data: { model_calls_reserved: { increment: 1 } },
    });

    if (claimed.count > 0) {
        return;
    }

    const created = await db.catalog_generation_batches.createMany({
        data: [
            {
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
        ],
        skipDuplicates: true,
    });

    if (created.count > 0) {
        return;
    }

    const claimedAfterCreate = await db.catalog_generation_batches.updateMany({
        where: { batch_key: input.batchKey, run_id: input.runId },
        data: { model_calls_reserved: { increment: 1 } },
    });

    if (claimedAfterCreate.count > 0) {
        return;
    }

    // The key is taken and the row is not ours. Reading the owner here, on the
    // failure path only, is what turns "that key is taken" into a message an
    // operator can act on; it is exact rather than a guess, because the key is
    // unique. A row that has vanished between the skipped insert and this read
    // means someone deleted the batch or its run mid-flight — nothing has been
    // reserved and nothing spent, so it is reported as the missing row it is.
    const owner = await db.catalog_generation_batches.findUnique({
        where: { batch_key: input.batchKey },
        select: { run_id: true },
    });

    if (!owner) {
        throw new ModelBudgetError(
            'batch_not_found',
            `No generation batch row could be found or created for batch key ${input.batchKey}: it was ` +
                'claimed by another writer and then removed. Nothing was reserved, so the call must not ' +
                'be made; re-run the stage to reserve again.',
        );
    }

    throw batchRunMismatchError(input.batchKey, owner.run_id, input.runId);
};

// The whole of the reservation decision, in the order that makes the cap a cap.
// Returns the reservation count the run held BEFORE this one, so the caller can
// report `reserved`/`remaining` without a second aggregate.
//
// THE CAP CHECK AND THE INCREMENT ARE ONE ATOMIC STEP, AND THAT IS WHY THE LOCK
// IS HERE. CATALOG_MODEL_CALL_BUDGET is a hard spending cap (Agent Action Plan
// §0.4.3), so the aggregate that decides "one more call fits" and the increment
// that consumes the allowance must not be separable: two callers reserving at
// `limit - 1` would otherwise both read `limit - 1`, both pass the check and
// both increment, and the run would spend past a cap an operator set in money.
// A per-RUN advisory lock is what serialises them — per run and not per batch
// key, because the cap spans every batch row the run owns, so two reservations
// under two DIFFERENT keys racing at `limit - 1` must queue behind each other
// too. (An earlier revision of this file argued the race could not occur
// because one process owns a run end to end. That is an assumption about every
// present and future caller, and it is not one a money cap should rest on.)
//
// ORDER IS LOAD-BEARING. The lock is taken BEFORE the aggregate: under
// PostgreSQL's read-committed default every statement takes a fresh snapshot,
// so the aggregate that runs once the lock is held sees the previous holder's
// committed increment. Raising the isolation level would break exactly that and
// must revisit this function. hashtext narrows the key to a 32-bit integer, so
// two unrelated runs can collide and then merely wait for each other, which is
// harmless.
//
// The locked section is four fast statements and contains NO vendor call — the
// model call happens after reserveModelCall returns — so a multi-hour import
// serialises on the ledger and on nothing else.
const claimModelCallReservation = async (
    db: CatalogRunDb,
    input: {
        runId: string;
        batchKey: string;
        category: string;
        model: string;
        promptVersion: string;
        logger?: ScriptLogger;
    },
    limit: number,
): Promise<number> => {
    await lockRunBudget(db, input.runId);

    // Before the aggregate, because a cap computed over a run that does not
    // exist or has already been settled is meaningless, and before the insert,
    // because the batch row's NOT NULL `run_id` foreign key would otherwise
    // refuse it as a raw Prisma error instead of the typed CheckpointError an
    // operator can read (see this module's header and checkpoint.requireOpenRun).
    // The row lock it takes is held for this transaction, so the run cannot be
    // deleted or closed between the check and the write.
    await requireOpenRun(db, input.runId);

    const reserved = await getReservedModelCalls(db, input.runId);

    // `>=`, unlike the `>` in assertModelCallBudget: there the question is
    // whether N more calls fit, here it is whether one more does. Thrown before
    // any increment and before the vendor call, so nothing has been spent and
    // the rollback of this transaction leaves the ledger exactly as it was.
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

    // The increment itself is still Prisma's atomic `{increment: 1}` — the same
    // idiom entitlement.service.ts uses on ai_usage.count — so the counter is
    // never computed in application code from a value that could be stale. The
    // lock is what makes the CHECK above safe, not what makes the write atomic.
    await bindReservationToRun(db, input);

    return reserved;
};

/**
 * Reserves one paid model call. Call this IMMEDIATELY BEFORE `callOpenRouter`,
 * never after — that ordering is the rule this module exists to enforce (§9).
 *
 * Throws `budget_exhausted` when the run has spent its cap, before any
 * increment and before the vendor call, so the caller's stop reason is a value
 * rather than a surprise bill. Throws `batch_run_mismatch` when the batch key
 * belongs to another run, because charging that run's ledger would both corrupt
 * its totals and leave this run's cap unenforced. Throws checkpoint.ts's
 * `CheckpointError('run_not_found' | 'run_not_open')` — not a ModelBudgetError —
 * when the run id does not exist or has already been settled, since run identity
 * is that module's contract and this one asks it before writing anything.
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
    const runner = transactionRunnerOf(db);

    // When we own the connection the lock, the aggregate and the increment run
    // inside one interactive transaction, so the lock is held for exactly as
    // long as the decision it protects. When the caller passed its own
    // transaction client we run IN PLACE — Prisma does not support nesting —
    // and the caller's transaction supplies the boundary. Either way it is the
    // LOCK that serialises, not the transaction; but a caller that brings its
    // own transaction holds this run's budget lock until IT commits, so such a
    // caller must not make the paid model call inside that transaction.
    const reserved = runner
        ? await runner.$transaction((tx) => claimModelCallReservation(tx, input, limit))
        : await claimModelCallReservation(db, input, limit);

    // Mirrored for the reports only: catalog-generate-ai.ts reads these keys
    // back into the `modelSpend` block of
    // data/meal-planning/reports/latest/import-report.json, and catalog-report.ts
    // reads them again, so `modelCallsReserved`, `modelCallsUsed` and
    // `tokensUsed` are a contract with those two scripts and must keep their
    // names. This runs AFTER the authoritative write and — when we own the
    // connection — OUTSIDE the reservation transaction, which is the order that
    // matters: if the mirror fails, the reservation still stands and the budget
    // stays enforceable, because the aggregate above is what enforces it. It is
    // also why the mirror is not inside the locked section: a diagnostic JSONB
    // merge must never be able to roll back a reservation that was already
    // decided. (A caller that brought its own transaction necessarily gets both
    // in that transaction — its boundary, its choice.)
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
 *
 * `runId` IS REQUIRED, and pairing it with the batch key is not ceremony: the
 * key is stable across runs, so usage addressed by key alone lands on whichever
 * run's row exists — the same defect the reservation path guards against, with
 * the added twist that the run whose budget paid for the call would show no
 * usage at all. The caller always knows its run id (it just reserved against
 * it), so the pairing is explicit rather than derived from the row, and a key
 * belonging to another run is refused instead of charged.
 */
export const recordModelCallUsage = async (
    db: CatalogRunDb,
    input: { runId: string; batchKey: string; succeeded: boolean; tokensUsed?: number; logger?: ScriptLogger },
): Promise<void> => {
    const tokensUsed = normalizeTokensUsed(input.tokensUsed);

    // One run-bound statement, so the two increments cannot be applied to
    // another run's row and need no lock of their own: Prisma's `{increment}`
    // is computed by PostgreSQL, not in application code, and the `run_id`
    // predicate is what makes the row this run's. No read precedes it — the
    // run id comes from the caller now, so the only reason left to read is to
    // explain a miss, which happens on the failure path below.
    const recorded = await db.catalog_generation_batches.updateMany({
        where: { batch_key: input.batchKey, run_id: input.runId },
        data: {
            model_calls_used: { increment: 1 },
            tokens_used: { increment: tokensUsed },
        },
    });

    // Usage recorded against a batch this run never reserved means a caller
    // spent without metering — the one bug this module exists to prevent — so
    // it is surfaced loudly rather than swallowed (§8). The extra read runs on
    // the failure path only (checkpoint.ts's classifyUnwritableRun does the
    // same) and exists because "no such key" and "that key is another run's" are
    // different mistakes with different fixes.
    //
    // findUnique on the key alone is exact here rather than approximate:
    // `batch_key` is UNIQUE across the table, so at most one row can carry it and
    // the `run_id` this read returns is the one run that reserved the call — the
    // run the mismatch message tells the operator to record against. A key-only
    // read would be unsafe to write through, which is why it selects and never
    // mutates.
    if (recorded.count === 0) {
        const existing = await db.catalog_generation_batches.findUnique({
            where: { batch_key: input.batchKey },
            select: { id: true, run_id: true },
        });

        if (!existing) {
            throw new ModelBudgetError(
                'batch_not_found',
                `No generation batch is reserved under batch key ${input.batchKey}: ` +
                    'reserveModelCall must run before recordModelCallUsage.',
            );
        }

        throw batchRunMismatchError(input.batchKey, existing.run_id, input.runId);
    }

    // The caller's run id, never the row's: mirroring into whatever run owned
    // the row is exactly how a run's reported spend drifts from what it paid.
    await recordCounts(db, input.runId, { modelCallsUsed: 1, tokensUsed });

    // Never the prompt, the completion, the API key or a caught error object —
    // logger.ts's safeError is the sanctioned way to reference a failure, and
    // the caller owns that reporting. This line carries counters only.
    input.logger?.info('model_call_recorded', {
        runId: input.runId,
        batchKey: input.batchKey,
        succeeded: input.succeeded,
        tokensUsed,
    });
};
