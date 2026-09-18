// Run state for the offline catalog pipeline — the single owner of reads and
// writes to `catalog_import_runs`.
//
// One row per pipeline run: a run is opened before any work happens, its
// `cursor` is rewritten as work completes so an interruption resumes instead of
// restarting, its `counts` accumulate, and it is finally closed as 'succeeded'
// or 'failed'. Four scripts drive it — catalog-import-usda.ts (checkpointing by
// manifest index), catalog-generate-ai.ts (by completed batch key),
// catalog-validate.ts and catalog-load.ts (by verified release file) — plus
// budget.ts, which mirrors its running model-call totals here through
// recordCounts. Each stage's resume key is a genuinely different shape, which is
// why `cursor` is generic rather than a fixed interface: this module round-trips
// it verbatim and never inspects it.
//
// The module persists run state and decides nothing else (Rule
// backend-architecture §1.1). It does not read manifests, meter budgets, judge
// catalog outcomes or verify checksums — its callers do. Following §1.2, the
// async functions below are I/O recipes and every decision they need lives in
// the exported pure functions above them.
//
// THE CONCURRENCY MODEL. Nothing prevents an operator from launching a stage
// twice, and budget.ts writes this row while a stage writes it too, so every
// write here is written for more than one writer:
//   * Claiming a run is serialised on a per-(kind, manifest_version) ADVISORY
//     LOCK (acquireRunClaimLock), so exactly one caller creates the run and the
//     rest converge on it rather than opening a competing second run. Read THE
//     CLAIM for what that does and does not promise — it guarantees one run ROW
//     and not one writer, and the difference is stated there rather than glossed
//     here.
//   * Being the only WRITER is a separate guarantee, kept by a separate
//     mechanism in this module: acquireCatalogStageLock / withCatalogStageLock
//     take a SESSION-scoped advisory lock on the whole catalog graph, on a
//     dedicated connection, for as long as a stage runs. The CLI entry points
//     take it (exclusively for the four mutating stages, shared for the
//     read-only export), so a second launch of a mutating stage is refused
//     before it writes anything. Read THE STAGE LOCK for the keyspace it uses
//     and why that choice is not cosmetic.
//   * EVERY write to a run row — cursor, counts, log and the close — first reads
//     that row with SELECT … FOR UPDATE (lockRunForUpdate) inside a transaction.
//     There is no unlocked write and no exception. `counts` and `log` need it
//     because they are JSONB maps that can only be accumulated by
//     read-modify-write and a transaction alone would NOT prevent a lost update;
//     the cursor takes it so the invariant holds uniformly rather than resting
//     on an assumption about how many writers exist.
//   * Closing a run is a one-way transition, taken under that row lock and
//     written with a status-guarded predicate, so a duplicate teardown can never
//     rewrite a settled outcome (see THE TERMINAL-TRANSITION RULE).
// Every lock lives for the surrounding transaction, which is this module's own
// when the caller passed the client, and the CALLER'S when it passed a `tx`.
//
// The run log is persisted state that operators read and the committed reports
// under data/meal-planning/reports/ copy, so every entry is written through
// sanitizeRunLogEntry — the storage-safe counterpart of logger.ts's terminal-
// safe formatting.
//
// TYPECHECKING NOTE: the type-only import below resolves to Prisma's generated
// client, which .gitignore excludes and which CI and the Docker build
// regenerate. `npx prisma generate` must therefore have run against the current
// prisma/schema.prisma before this file typechecks — a fresh checkout has no
// src/generated/prisma directory at all.

// hostOf, isSecretBearingKey, safeError and scrubSecrets are logger.ts's
// exported redaction primitives. They are IMPORTED rather than re-implemented so
// the pipeline has exactly one definition of "what is a secret": adding a
// credential-bearing variable to .env.example means adding a rule (or a key
// name) there, and this module then enforces it on persisted state too.
// isSecretBearingKey in particular used to live only here, which is how the
// terminal and this column came to enforce two different contracts for one
// payload: a bare secret under `password` was replaced on its way into this
// column and printed verbatim on its way to an operator's screen, so the
// terminal showed what the database deliberately never stored. It is defined
// once now. logger.ts's own recursive sanitizer is private and shapes a terminal
// line, so the recursion for a stored JSONB entry lives here (see
// sanitizeRunLogEntry) and is built on those four exports.
// Node's own hashing, for the run keys below. Nothing here hashes a secret; the
// digests name a catalog input and a pass restriction so an operator-readable
// `manifest_version` can carry both (see WHICH CATALOG A VALIDATION RUN ANSWERS
// FOR).
import crypto from 'crypto';

import { ScriptLogger, hostOf, isSecretBearingKey, isThrownInstanceOf, safeError, scrubSecrets } from './logger';
import type { LogFields } from './logger';

// Types only. Rule §12 forbids editing or reviewing src/generated/prisma, not
// importing from it — this is the same module src/prisma/client.ts imports. The
// import stays type-only for a second reason worth knowing: it means no runtime
// value from the generated client is reachable here, so nothing in this file can
// construct a client or reach for the `prisma` singleton by accident. The caller
// injects `db`, which is what lets catalog-load.ts hand in either the singleton
// or its own interactive-transaction client, and lets the script suites under
// src/__tests__/scripts hand in the test client (§11 — Jest's `roots` is
// <rootDir>/src, so no test file can live beside this one).
import type { PrismaClient, Prisma } from '../../src/generated/prisma';

// Accepting both shapes is the point. catalog-load.ts verifies a release and
// moves the active-release pointer inside one $transaction; passing that `tx`
// here keeps the checkpoint write in the same atomic unit, so a load that fails
// partway cannot leave behind a run row claiming success.
export type CatalogRunDb = PrismaClient | Prisma.TransactionClient;

// The pipeline stages that own a run. Closed so the four scripts cannot drift
// onto near-miss spellings: a run is found again by kind + manifest_version, so
// a typo silently turns "resume" into "start over".
//
// The column is TEXT with no CHECK constraint, and prisma/schema.prisma's inline
// comment additionally lists 'release' — the kind catalog-release.ts writes when
// it freezes a release. That script deliberately does not go through this
// module, so the union stays at the four kinds this module's callers open, and
// toCatalogRun preserves rather than rewrites any other value it meets.
export type CatalogRunKind = 'usda_import' | 'ai_generation' | 'validation' | 'release_load';

export type CatalogRunStatus = 'running' | 'succeeded' | 'failed';

// Every stage that contends for the catalog graph, which is the four run kinds
// plus the two read-only ones. Neither `release` nor `benchmark` is a
// CatalogRunKind — that union is the set of stages that OPEN a resumable run
// through this module, and catalog-release.ts writes its audit row directly
// (see the note on CatalogRunKind) while scripts/search-benchmark.ts opens no
// run row at all — but both are stages for locking purposes, because each reads
// the whole published graph and must not read one a mutator is rewriting.
export type CatalogStageName = CatalogRunKind | 'release' | 'benchmark';

export type CatalogStageLockMode = 'exclusive' | 'shared';

// THE STAGE LOCK'S CONTRACT, stage by stage.
//
// Four stages MUTATE the catalog graph and take the lock EXCLUSIVELY, so no two
// of them ever run against one database at the same time:
//   * usda_import    — upserts foods and their children by source_key;
//   * ai_generation  — the same, for generated candidates: it upserts
//                      catalog_foods by source_key and replaces their aliases,
//                      portions and validation records, reserving a paid model
//                      call before each batch. Every invocation that writes
//                      takes this lock at the entry point —
//                      catalog-generate-ai.ts wraps runGeneration in
//                      withCatalogStageLock({ stage: RUN_KIND }) (see THE
//                      GENERATION STAGE'S CLAIM there) — and the one invocation
//                      that does not is `--dry-run`, which writes nothing and
//                      must stay answerable while a real run holds the lock;
//   * validation     — re-judges rows and moves publication_status;
//   * release_load   — reconciles a release into the graph and retires rows.
// Two stages only READ it and take the lock SHARED:
//   * release        — exports the published graph to a versioned release. Shared
//                      rather than exclusive because two exports of one database
//                      are harmless, while an export concurrent with ANY mutator
//                      would freeze a graph that is still moving — the exact
//                      defect this table exists to prevent.
//   * benchmark      — measures search against the published graph and writes the
//                      acceptance-evidence report (scripts/search-benchmark.ts).
//                      Shared for the same reason as `release`: it only reads, so
//                      two benchmark runs against one database are harmless,
//                      while a run concurrent with any mutator would produce one
//                      report whose queries spanned two committed catalog states
//                      — measurements of a corpus that never existed as a whole,
//                      which is not evidence of anything.
export const CATALOG_STAGE_LOCK_MODES: Readonly<Record<CatalogStageName, CatalogStageLockMode>> = {
    usda_import: 'exclusive',
    ai_generation: 'exclusive',
    validation: 'exclusive',
    release_load: 'exclusive',
    release: 'shared',
    benchmark: 'shared',
};

// ONE LOCK NAME FOR THE WHOLE GRAPH, not one per stage.
//
// Exclusivity is a property of the catalog graph rather than of a stage kind: an
// import and a validation pass collide because they write the same rows, not
// because they share a name. Keying the lock by stage kind would let exactly the
// pair of stages this lock exists to separate run at once, which is the defect
// the run claim already has (it is keyed by kind + manifest_version and is
// therefore blind to a different stage working the same graph).
const CATALOG_GRAPH_LOCK_NAME = 'catalog-graph';

// WHY THE TWO-INTEGER ADVISORY KEYSPACE, AND WHY IT IS THE MOST IMPORTANT FACT
// ABOUT THIS LOCK.
//
// PostgreSQL documents the one-argument (bigint) and two-argument (int, int)
// advisory lock spaces as DISTINCT: a lock taken as pg_advisory_lock(k) never
// conflicts with one taken as pg_advisory_lock(c, k). This lock therefore uses
// the two-argument form with the class id below, because everything else in this
// system that takes an advisory lock uses the ONE-argument form over
// `hashtext(...)`:
//   * the request path serialises every mutating meal-planning transaction on
//     `pg_advisory_xact_lock(hashtext('meal-planning:' || userId))` (Agent Action
//     Plan §0.5.1, "Lock first");
//   * acquireRunClaimLock in this very file takes
//     `pg_advisory_xact_lock(hashtext('catalog-run:<kind>:<version>'))`.
// hashtext narrows to 32 bits, so two unrelated names CAN hash to the same key.
// For those two that costs a few milliseconds of waiting. For THIS lock it would
// be an outage: it is held for the hours an import or a validation pass takes,
// on a session rather than a transaction, so a collision with a user's
// meal-planning write would block that user's request for the whole stage. The
// separate keyspace makes that collision impossible rather than unlikely.
//
// The class id is the ASCII bytes of 'CAT' (0x434154) — an arbitrary but fixed
// and documented constant, which is all a class id has to be. Every catalog
// stage uses it, so all of them contend, and nothing outside this file does.
const CATALOG_STAGE_LOCK_CLASS_ID = 0x434154;

// THE ACTIVE-RELEASE CONVENTION, AND WHY IT IS DUPLICATED IN src/.
//
// The active catalog release is the newest `catalog_import_runs` row with
// kind = 'release_load' and status = 'succeeded'. Nothing else records it, which
// is what makes a failed load harmless: it never reaches that state, so the
// previous release simply stays active (see finishRun and getActiveReleaseLoad).
//
// src/services/catalog.service.ts::getStatus serves GET /api/catalog/status and
// must apply the identical rule, but it CANNOT import it from here. The
// dependency direction is one-way — scripts/ imports ../src/*, never the
// reverse — and .dockerignore keeps scripts/ out of the runtime image, so an
// import reaching from src/ into scripts/ would break the very build the API
// ships in. The convention is therefore exported here as constants and
// re-implemented there. If the two ever disagree, the operator-facing pointer
// and the API disagree about which catalog is live: change both, and do not
// "fix" the duplication by adding that illegal import.
export const RELEASE_LOAD_RUN_KIND: CatalogRunKind = 'release_load';
export const RUN_STATUS_SUCCEEDED: CatalogRunStatus = 'succeeded';

// `log` is an unbounded JSONB array on a row that every checkpoint write reads
// or rewrites. A single generation run works through ~13,765 candidates, so an
// uncapped log would grow the row into the megabytes and make each subsequent
// resume read progressively more expensive — for diagnostics whose value is
// almost entirely in the most recent entries. The cap keeps the newest and drops
// the oldest; the committed reports under data/meal-planning/reports/ are where
// a full audit trail belongs.
export const RUN_LOG_MAX_ENTRIES = 200;

// ---------------------------------------------------------------------------
// WHICH CATALOG A VALIDATION RUN ANSWERS FOR.
//
// A validation run key names two things, and it has to name both or it answers
// the wrong question:
//
//   * the POLICY the rows were judged against — the coverage plan version, whose
//     bounds every verdict is computed from; and
//   * the INPUT that was judged — the graph as the last ingest left it.
//
// Keyed on the policy alone, one successful pass answers "validation succeeded
// for v1" for ever, so a later import or release load under the same coverage
// plan is met with the completed-run no-op and its rows are never judged. AAP
// §0.5.1 requires the opposite ("a refresh re-runs validation"), and the
// consequence is worse than a missed pass: catalog-release's prerequisite asks
// for a validation newer than the last ingest, so the release would wait on a
// run that can no longer happen — a deadlock clearable only by bumping an
// unrelated coverage plan version.
//
// Keyed on both, a refresh is NEW WORK by construction and re-running the stage
// against an unchanged graph is still a no-op. That is the whole of the rule.
//
// It lives here, in the run-ledger module, because the identity is derived from
// run rows and because BOTH sides need exactly the same definition:
// catalog-validate.ts to claim the key, and catalog-release.ts to decide which
// validation row is the canonical one. A second definition would let the two
// disagree about the same catalog.
// ---------------------------------------------------------------------------

/**
 * The run kinds that change the FACTS in the catalog graph.
 *
 * Validation is deliberately absent: it moves `publication_status` and writes
 * validation records, and it never changes a food's nutrients, its basis or its
 * metadata. Were it included, every pass would change the identity of the input
 * it was judging and no validation could ever be complete.
 */
export const GRAPH_MUTATING_RUN_KINDS: readonly CatalogRunKind[] = [
    'usda_import',
    'ai_generation',
    RELEASE_LOAD_RUN_KIND,
];

/** The run-ledger fields the identity is derived from. Structural, so both stages' row types satisfy it. */
export interface CatalogInputRunRow {
    readonly kind: string;
    readonly manifest_version: string;
    readonly status: string;
    readonly finished_at: Date | null;
}

/** A graph with no ingest on record — a database whose catalog was never loaded. */
export const NO_CATALOG_INPUT = 'none';

/** The marker that separates a canonical key from the restriction narrowing it. */
export const VALIDATION_SCOPE_SEPARATOR = '+scope:';

/**
 * Names the graph the last completed ingest left, as a value a run key can
 * carry.
 *
 * Derived from the ledger rather than from the graph on purpose: the key has to
 * be known BEFORE the completed-run no-op decides whether to read the graph at
 * all, and the ledger is the one record of "what was loaded" that is readable
 * without touching a single food.
 *
 * Only SUCCEEDED runs count. An open or failed ingest left the graph in a state
 * nobody has vouched for, and naming it would mint a key for a half-written
 * catalog; the release prerequisite refuses on such a row separately, which is
 * where that case belongs.
 *
 * @param runs ledger rows; anything that is not a succeeded graph-mutating run is ignored
 * @returns `kind:manifest_version:finishedAt`, or {@link NO_CATALOG_INPUT}
 */
export const catalogInputIdentity = (runs: readonly CatalogInputRunRow[]): string => {
    const ingests = runs.filter(
        (run) =>
            GRAPH_MUTATING_RUN_KINDS.includes(run.kind as CatalogRunKind) &&
            run.status === RUN_STATUS_SUCCEEDED &&
            run.finished_at !== null,
    );

    if (ingests.length === 0) {
        return NO_CATALOG_INPUT;
    }

    // Newest wins, and ties break on kind then manifest version so the identity
    // is a function of the ledger's CONTENT and not of the order it came back
    // in — two stages computing this must agree to the character.
    const newest = ingests.reduce((best, run) => {
        const at = (run.finished_at as Date).getTime();
        const bestAt = (best.finished_at as Date).getTime();
        if (at !== bestAt) {
            return at > bestAt ? run : best;
        }
        const left = `${run.kind}:${run.manifest_version}`;
        const right = `${best.kind}:${best.manifest_version}`;
        return left > right ? run : best;
    });

    return `${newest.kind}:${newest.manifest_version}:${(newest.finished_at as Date).toISOString()}`;
};

/**
 * The key a CANONICAL full validation pass claims, and the only key
 * catalog-release accepts as a validation prerequisite.
 *
 * Kept short: the input identity is hashed rather than embedded, because
 * `manifest_version` is a database column an operator reads in a terminal, and
 * a full ISO timestamp plus a manifest name would make every log line and every
 * refusal message unreadable. Twelve hex characters distinguish every catalog a
 * database will ever hold.
 */
export const canonicalValidationRunKey = (coveragePlanVersion: string, inputIdentity: string): string =>
    `${coveragePlanVersion}@${crypto.createHash('sha256').update(inputIdentity).digest('hex').slice(0, 12)}`;

/**
 * True for a key that names a RESTRICTED pass — one narrowed by `--category` or
 * widened by `--revalidate-quarantined`.
 *
 * catalog-release asks this because such a pass judged a fraction of the plan:
 * it may resume and may refuse to redo itself, but it must never stand in for
 * the canonical pass in a release prerequisite.
 */
export const isRestrictedValidationRunKey = (manifestVersion: string): boolean =>
    manifestVersion.includes(VALIDATION_SCOPE_SEPARATOR);

/** The marker that separates the policy from the catalog input in a validation run key. */
export const VALIDATION_INPUT_SEPARATOR = '@';

/**
 * True for a validation run key that states WHICH CATALOG it judged.
 *
 * False for a key recorded before the key named the input — a bare coverage plan
 * version. Such a row is not wrong, it is simply silent about the thing a
 * release needs to know, and catalog-release says exactly that rather than
 * accusing the operator of an import they did not run.
 */
export const validationRunKeyNamesInput = (manifestVersion: string): boolean =>
    manifestVersion.includes(VALIDATION_INPUT_SEPARATOR);

/**
 * The catalog-input half of a validation run key, or `null` for a key that does
 * not name one.
 *
 * Exists so a refusal can tell an operator WHICH half disagrees. "No canonical
 * validation" has three quite different causes — a different catalog, a
 * different coverage plan, a run recorded before keys named the catalog — and
 * each has its own remedy, so a message that lumps them together sends the
 * operator looking for an import that never happened.
 */
export const validationRunKeyInputPart = (manifestVersion: string): string | null => {
    const separator = manifestVersion.indexOf(VALIDATION_INPUT_SEPARATOR);
    if (separator === -1) {
        return null;
    }
    const afterPlan = manifestVersion.slice(separator + VALIDATION_INPUT_SEPARATOR.length);
    const restriction = afterPlan.indexOf(VALIDATION_SCOPE_SEPARATOR);
    return restriction === -1 ? afterPlan : afterPlan.slice(0, restriction);
};

// Not exported: the open and failed statuses are this module's internal
// lifecycle detail, whereas the two constants above are a contract shared with
// src/ and the runbook.
const RUN_STATUS_RUNNING: CatalogRunStatus = 'running';
const RUN_STATUS_FAILED: CatalogRunStatus = 'failed';

export type CheckpointErrorCode =
    | 'run_not_found'
    | 'run_not_open'
    | 'run_already_finished'
    | 'run_resume_not_requested'
    | 'catalog_stage_locked'
    | 'catalog_stage_lock_unavailable';

// What a stage-lock error is about. The two stage-lock codes name a STAGE rather
// than a run, because the lock is taken BEFORE any run is claimed — that is the
// point of it (see THE STAGE LOCK) — so `CheckpointError.runId` is empty for
// them by construction and this subject carries the diagnosis instead.
export interface CatalogStageLockSubject {
    readonly stage: CatalogStageName;
    readonly mode: CatalogStageLockMode;
    /** How long acquisition waited before giving up. 0 when it refused at once. */
    readonly waitedMs: number;
}

// Kept as a function rather than inline in the constructor so a third code
// could be added without disturbing the two messages that already exist: both
// are byte-identical to what this module has always thrown, because they reach
// operator terminals and the committed reports.
const checkpointErrorMessage = (
    code: CheckpointErrorCode,
    runId: string,
    storedStatus?: CatalogRunStatus,
    stageLock?: CatalogStageLockSubject,
): string => {
    if (code === 'run_not_found') {
        return `Catalog run ${runId} does not exist`;
    }
    if (code === 'run_already_finished') {
        // The stored status is named in the message because it is the whole
        // diagnosis: "already succeeded" while closing as failed is a very
        // different incident from the reverse (see finishRun).
        return storedStatus
            ? `Catalog run ${runId} is already ${storedStatus}`
            : `Catalog run ${runId} is already finished`;
    }
    if (code === 'run_resume_not_requested') {
        // Says what was found, what will happen to it, and what the operator
        // types. The last part matters because the alternative an operator
        // reaches for — "start a fresh run instead" — is not available: runs are
        // keyed by (kind, manifestVersion) precisely so a repeat recognises
        // completed work, so an unfinished run under that key is either resumed
        // or left alone.
        return (
            `Catalog run ${runId} is unfinished (${storedStatus ?? RUN_STATUS_RUNNING}) and this stage was not asked ` +
            'to resume it. Re-run with --resume to continue it from its stored cursor. A second run for the same ' +
            'key cannot be opened alongside it: the runs are keyed so that a repeat recognises work already done, ' +
            'and its checkpoint is what makes continuing cheap.'
        );
    }
    if (code === 'catalog_stage_locked') {
        // Names the stage, the mode it asked for and how long it waited, because
        // those three are what an operator needs to decide between waiting and
        // stopping the other stage. The remedy is spelled out rather than
        // implied: a stage lock is held by a live process, so there is nothing
        // to clean up — the other launch either finishes or is stopped.
        const stage = stageLock?.stage ?? 'a catalog stage';
        const mode = stageLock?.mode ?? 'exclusive';
        const waited = stageLock?.waitedMs ?? 0;
        return (
            `Another catalog pipeline stage holds the lock on the catalog graph, so ${stage} cannot take it ` +
            `${mode === 'shared' ? 'shared' : 'exclusively'} (waited ${waited} ms). Wait for the running stage to ` +
            'finish, or stop it, and run this stage again — it resumes from its checkpoint.'
        );
    }
    if (code === 'catalog_stage_lock_unavailable') {
        // Reached only when DATABASE_URL is absent or empty, which dbGuard
        // normally refuses at module load. Reported as its own code because
        // "nobody else holds the lock, this process cannot take one" is a
        // different operator action from "wait your turn".
        const stage = stageLock?.stage ?? 'a catalog stage';
        return (
            `No database connection string is available (DATABASE_URL is unset or empty), so ${stage} cannot open ` +
            'the dedicated connection its stage lock is held on. Set DATABASE_URL (see backend/.env.example) and ' +
            'run the stage again.'
        );
    }
    return `Catalog run ${runId} is no longer open`;
};

// Follows the DailyQuotaError template in src/services/entitlement.service.ts:
// a named class carrying the data the caller needs rather than a string (§8).
// The codes are worth distinguishing because they mean different operator
// mistakes — a run id that no longer exists (wrong database, wrong environment),
// a checkpoint written into a run that was already closed (a script that lost
// track of its own run, which would otherwise corrupt a finished record), a
// second teardown trying to close an already-terminal run as the OTHER status
// (`run_already_finished`, which finishRun refuses because it would rewrite a
// settled outcome — see the transition rule there), and the two stage-lock
// refusals (another stage owns the catalog graph, or this process has no
// connection string to hold a lock on).
//
// One class rather than a subclass per code, deliberately: every script's
// `describeFailure` reports `error.code` for anything that is an instanceof
// CheckpointError, so a new code reaches operator terminals and the committed
// reports under its own name with no change to the five scripts.
//
// `storedStatus` and `stageLock` are optional so every existing two-argument
// construction in this module and its callers keeps compiling and keeps
// producing the same message; only the conflicting-transition path passes the
// first, and only the stage lock passes the second.
export class CheckpointError extends Error {
    constructor(
        public readonly code: CheckpointErrorCode,
        public readonly runId: string,
        public readonly storedStatus?: CatalogRunStatus,
        public readonly stageLock?: CatalogStageLockSubject,
    ) {
        super(checkpointErrorMessage(code, runId, storedStatus, stageLock));
        this.name = 'CheckpointError';
    }
}

/**
 * What a refusal from this module is worth REPORTING, as typed fields rather
 * than as its rendered sentence.
 *
 * WHY THIS EXISTS. `safeError` carries a closed set of machine-readable members
 * and deliberately no `message`, because a message reaching an operator log or
 * the `catalog_import_runs.log` column is prose the reporting stage did not
 * compose — from a driver, a vendor edge or a parser — and can quote a
 * connection URL, a key, or the document that failed. That rule costs nothing
 * for a foreign error and would cost something HERE: the sentence this module
 * renders for `catalog_stage_locked` names the stage holding the graph and the
 * mode it asked for, and those two are exactly what an operator needs to choose
 * between waiting and stopping the other launch. An export taking the lock
 * exclusively and a mutator taking it shared are different mistakes, and the
 * mode is what tells them apart.
 *
 * So the facts travel as the DATA they already are — every value below is a
 * constrained member of this module's own vocabulary (a `CatalogStageName`, a
 * `CatalogStageLockMode`, a `CatalogRunStatus`, a run id this system minted, a
 * number) — and the rendered sentence stays where it belongs, on the thrown
 * error an operator reads at the terminal.
 *
 * Absent members are ABSENT rather than `undefined`, for the same reason
 * `safeError` assembles itself that way: these fields are serialised into a
 * JSONB column, where `{lockMode: undefined}` reads as a mode that was lost
 * rather than one that never applied.
 */
export const checkpointErrorFields = (error: CheckpointError): LogFields => ({
    runId: error.runId,
    ...(error.storedStatus === undefined ? {} : { runStatus: error.storedStatus }),
    ...(error.stageLock === undefined
        ? {}
        : {
              lockStage: error.stageLock.stage,
              lockMode: error.stageLock.mode,
              lockWaitedMs: error.stageLock.waitedMs,
          }),
});

export interface CatalogRun<TCursor = unknown> {
    id: string;
    kind: CatalogRunKind;
    manifestVersion: string;
    status: CatalogRunStatus;
    startedAt: Date;
    finishedAt: Date | null;
    cursor: TCursor | null;
    counts: Readonly<Record<string, number>>;
}

// What openOrResumeRun answers. Three booleans' worth of outcome in two flags,
// because they are not independent: `resumed` covers a run this claim continued
// (an interrupted one picked up from its cursor, or a failed one retried on the
// same row), and `alreadyCompleted` is the one outcome in which the caller must
// NOT work — the stage is settled and nothing was written. Both false means a
// fresh run. See THE CLAIM for why a completed stage is an outcome at all rather
// than simply another new run.
export interface CatalogRunClaim<TCursor = unknown> {
    run: CatalogRun<TCursor>;
    resumed: boolean;
    alreadyCompleted: boolean;
}

// ---------------------------------------------------------------------------
// Pure decisions (§1.2). Exported so the unit suite under src/__tests__ can pin
// them with no database: the addition semantics of mergeCounts, the retention
// window of appendCappedLog and the null handling of toCatalogRun are each a
// rule someone could get wrong.
// ---------------------------------------------------------------------------

// Arrays are excluded: a JSONB array is a valid JsonValue but is never a counter
// map or a run row, and treating one as a record would silently produce numeric
// keys.
const isPlainRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);

// A counter literally named '__proto__' would mutate the result object's
// prototype on assignment instead of becoming a key. These keys come from this
// pipeline's own JSONB rather than from user input, but the guard is one line and
// the failure it prevents is silent.
const UNSAFE_COUNT_KEY = '__proto__';

const toDateOrNull = (value: unknown): Date | null => {
    if (value instanceof Date) {
        return Number.isNaN(value.getTime()) ? null : value;
    }
    // Prisma hands back Date objects; a string or epoch number only appears if a
    // caller fetched the row through $queryRaw.
    if (typeof value === 'string' || typeof value === 'number') {
        const parsed = new Date(value);
        return Number.isNaN(parsed.getTime()) ? null : parsed;
    }
    return null;
};

// Accumulates counters by ADDITION, never replacement. This is what makes a
// resumed run's totals correct: the second half of an interrupted import adds to
// what the first half already recorded instead of overwriting it. It is also why
// budget.ts can mirror model-call totals here cheaply.
//
// Note the shape this cannot use: entitlement.service.ts increments
// ai_usage.count with Prisma's atomic `{increment: 1}`, but Prisma cannot
// increment a key *inside* a JSONB column, so accumulation has to happen in
// application code — here — and the caller-facing consequence is recordCounts'
// read-modify-write.
export const mergeCounts = (existing: unknown, delta: Record<string, number>): Record<string, number> => {
    const merged: Record<string, number> = {};

    // An unexpected stored shape (SQL NULL, a JSON literal null, or a value some
    // other writer left behind) is treated as "no counters yet" rather than
    // throwing: refusing to record progress because a diagnostic column is
    // malformed would abandon a multi-hour run for no gain.
    if (isPlainRecord(existing)) {
        for (const key of Object.keys(existing)) {
            const value = existing[key];
            // A stored non-number is not a counter. It is dropped rather than
            // coerced, so a NaN or a string can never become part of a total.
            if (key !== UNSAFE_COUNT_KEY && typeof value === 'number' && Number.isFinite(value)) {
                merged[key] = value;
            }
        }
    }

    // Guarded rather than trusted, like logger.ts's own inputs: the declared
    // type does not bind a JavaScript caller, and one NaN increment would poison
    // a total irrecoverably — JSON.stringify turns it into null on the way to the
    // column, so the damage would outlive the run.
    if (isPlainRecord(delta)) {
        for (const key of Object.keys(delta)) {
            const increment = delta[key];
            if (key === UNSAFE_COUNT_KEY || typeof increment !== 'number' || !Number.isFinite(increment)) {
                continue;
            }
            merged[key] = (merged[key] ?? 0) + increment;
        }
    }

    return merged;
};

// Appends one entry and keeps the MOST RECENT `maxEntries` (see
// RUN_LOG_MAX_ENTRIES for why a cap exists at all).
//
// The cap arrives from a caller, so each of the four shapes it can have is given
// an explicit meaning instead of collapsing into one. The reading of each, and
// why it is that:
//   * A FINITE POSITIVE cap keeps the newest `floor(cap)` entries INCLUDING the
//     one just appended, which is the production case — `1` therefore yields the
//     new entry alone.
//   * A NON-FINITE POSITIVE cap (`Infinity`) means UNBOUNDED: every retained
//     entry plus the new one. It used to return `[]`, because
//     `Number.isFinite(Infinity)` is false and the fallback collapsed the limit
//     to 0 — so asking for "no limit" destroyed the entire run log and the entry
//     being written, the exact opposite of what was asked for.
//   * ZERO OR NEGATIVE, `-Infinity` included, keeps the documented total
//     discard. A caller asking for room for nothing gets nothing, and that is a
//     coherent request rather than a mistake to second-guess.
//   * NOT A NUMBER AT ALL, `NaN` included, has no defensible reading, so it
//     falls back to RUN_LOG_MAX_ENTRIES rather than losing the log over it. The
//     declared type does not bind a JavaScript caller, and this function runs
//     inside the statement that records a run's progress — the stored log is the
//     only account of what the run did, so the safe failure is to keep it capped
//     at the module's own default, never to empty it.
export const appendCappedLog = (
    existing: unknown,
    entry: Record<string, unknown>,
    maxEntries: number,
): Record<string, unknown>[] => {
    // Resolved first so every branch below reasons about a cap already known to
    // be a number; `Number.isNaN` rather than a comparison because NaN fails
    // both `< 1` and `>= 1` and would otherwise fall through to the slice.
    const requested = typeof maxEntries === 'number' && !Number.isNaN(maxEntries) ? maxEntries : RUN_LOG_MAX_ENTRIES;

    if (requested < 1) {
        // Array.prototype.slice(-0) returns the WHOLE array rather than none of
        // it, so a zero or negative cap has to short-circuit here instead of
        // falling through to the slice below.
        return [];
    }

    const previous: unknown[] = Array.isArray(existing) ? existing : [];
    // Non-object members are dropped: the log is read back by the report scripts,
    // which expect a homogeneous array of entries.
    const entries = previous.filter(isPlainRecord);
    entries.push(isPlainRecord(entry) ? entry : {});

    if (!Number.isFinite(requested)) {
        // Unbounded, and returned before the slice because `slice(-Infinity)` is
        // a `NaN` offset that silently yields the whole array for the wrong
        // reason — this branch says what it means.
        return entries;
    }

    // Negative slice keeps the tail, which is the newest end — entries are always
    // appended.
    return entries.slice(-Math.floor(requested));
};

// THE STORAGE SECURITY CONTRACT OF THE RUN LOG.
//
// `log` is not a terminal line that scrolls away: it is persisted state that
// operators read with psql, that catalog-report.ts copies into the committed
// reports under data/meal-planning/reports/, and that survives the run by
// design. Callers pass arbitrary diagnostics into appendRunLog — a failed USDA
// request URL (api_key lives in its query string), an OpenRouter error body (it
// can reflect the Authorization header), a Prisma failure (it echoes
// DATABASE_URL, whose userinfo carries the password), a thrown Error with its
// stack, a model-proposed evidence URL, a whole vendor response. Writing any of
// those verbatim commits a credential to the database and then to a file in git.
//
// So every entry is reduced to a storage-safe value first. The rules, and why
// each one exists:
//   * Every string value and every object KEY goes through logger.ts's
//     scrubSecrets — the single definition of a secret pattern in this pipeline.
//   * A value whose KEY NAMES a credential is replaced outright. scrubSecrets
//     recognises `password=hunter2` inside a string but cannot know that a bare
//     `hunter2` stored under a key called `password` is the same secret, so for
//     those names the key is the only signal there is. That vocabulary is
//     logger.ts's isSecretBearingKey — one definition shared with the terminal
//     path, not a second list maintained here (see the note above
//     truncateForStorage for the two exclusions it turns on).
//   * An Error becomes safeError's CLOSED fields — the class name, plus a
//     machine `code` and an HTTP `status` when the value carries them: never
//     the object, never the stack, never a `cause`, and never the message (§8).
//     This column is the durable half of the pipeline's diagnostics and is
//     copied into committed report artefacts, so it is the sink logger.ts's
//     safeError was narrowed for — a foreign message carries the connection
//     target, a failing statement's values or an absolute path, and no pattern
//     list recognises those. What the entry says about the failure is the
//     caller's own `event`, `code` and context fields beside it.
//   * Anything URL-shaped is reduced to its HOST. Evidence URLs are
//     model-proposed and therefore attacker-influenced input that the Agent
//     Action Plan (§0.3.2) records at host level only, and a path or query
//     segment can carry a credential that no pattern list reliably catches. Two
//     independent triggers, because either alone leaks: a key in
//     RUN_LOG_URL_KEYS (the documented closed set below), and any value that
//     looks like an absolute `scheme://` URL whatever its key is called.
//   * Strings are capped. The AAP caps a stored evidence snippet at 500
//     characters (§0.3.2) and that is the precedent followed here, so a vendor
//     body or a stack pasted into a field cannot become row content.
//   * Depth is capped at 8, the same bound logger.ts uses for log fields
//     (MAX_FIELD_DEPTH), with a cycle guard, an array cap and explicit handling
//     for the values JSON cannot represent — a JSONB column cannot hold NaN,
//     Infinity, a bigint, a function or a symbol, and JSON.stringify turns the
//     first two into `null` silently.
//   * `__proto__` is dropped, for the reason UNSAFE_COUNT_KEY documents.
//   * `at` and `event` are AUTHORITATIVE. They are written from the injected
//     clock and the typed parameter, and a caller field of the same name is
//     dropped rather than allowed to win. The previous code spread caller fields
//     last and invited overriding `at`, which is log-record forgery in persisted
//     state: an entry could claim any time, or masquerade as another event, in
//     the record an operator uses to reconstruct what a run did. A caller that
//     legitimately means to record an earlier moment passes its own field name
//     (`observedAt`, `fetchedAt`), which is preserved untouched.
const RUN_LOG_MAX_FIELD_DEPTH = 8;
const RUN_LOG_MAX_STRING_CHARS = 500;

// A log entry is a diagnostic, not a payload. The longest array a caller here
// legitimately records is one generation batch of candidate keys
// (CATALOG_BATCH_SIZE = 25), so this leaves headroom while still bounding the
// row that every checkpoint write reads.
const RUN_LOG_MAX_ARRAY_ENTRIES = 50;

// Mirrors logger.ts's markers so a reader meets one vocabulary across the
// terminal output and the stored log (its REDACTED and UNSERIALIZABLE constants
// are private, so the values — not the constants — are what is shared).
const RUN_LOG_UNSERIALIZABLE = '[unserializable]';
const RUN_LOG_REDACTED = '***';
const RUN_LOG_TRUNCATED = '[truncated]';
const RUN_LOG_INVALID_TIMESTAMP = 'invalid-timestamp';
const RUN_LOG_UNKNOWN_EVENT = 'unknown_event';

const RUN_LOG_AT_KEY = 'at';
const RUN_LOG_EVENT_KEY = 'event';

// The closed set of field names whose value is treated as a URL regardless of
// its shape, matched case-insensitively. Closed rather than heuristic so the
// policy is reviewable: these are the names this pipeline's diagnostics use for
// a location (`evidenceUrl`, `finalUrl` and `sourceUrl` come from the evidence
// retrieval record, `requestUrl` from the USDA and OpenRouter call sites,
// `location` from a redirect header). A value under one of these keys that does
// not parse as a URL becomes hostOf's 'invalid-url' — deliberately, because a
// URL-bearing key is attacker-influenced and what is left of an unparseable
// value is exactly the part that could hide a credential.
const RUN_LOG_URL_KEYS = new Set([
    'url',
    'uri',
    'href',
    'link',
    'endpoint',
    'location',
    'requesturl',
    'evidenceurl',
    'finalurl',
    'sourceurl',
]);

// Deliberately loose: it matches the RFC 3986 scheme grammar followed by `//`,
// so `postgresql://`, `https://` and any vendor scheme all trip it. Matching too
// eagerly costs a diagnostic its path; matching too narrowly stores a secret.
const ABSOLUTE_URL_PATTERN = /^[a-z][a-z0-9+.-]*:\/\//i;

// Field names whose VALUE is a credential, not a string that might contain one,
// are recognised by logger.ts's `isSecretBearingKey` — IMPORTED for the same
// reason scrubSecrets is, so the terminal and this column cannot disagree about
// the same payload. Two properties of that vocabulary are load-bearing HERE and
// are recorded here so a future edit to it meets the reason before the list. The
// bare word `key` is EXCLUDED, because this pipeline's diagnostics legitimately
// record `batchKey`, `sourceKey` and `manifestKey`, and redacting a resume key
// would cost an operator the one field that explains where a run stopped. And
// multi-word names that only read as a credential when joined (`apiKey`,
// `x-api-key`, `accessToken`) are matched as PHRASES against the key with its
// separators removed, since splitting them into words would produce the excluded
// `key` again.
const truncateForStorage = (value: string): string =>
    value.length > RUN_LOG_MAX_STRING_CHARS
        ? `${value.slice(0, RUN_LOG_MAX_STRING_CHARS)}${RUN_LOG_TRUNCATED}`
        : value;

const isUrlBearingKey = (key: string): boolean => RUN_LOG_URL_KEYS.has(key.toLowerCase());

const sanitizeRunLogString = (value: string, urlBearing: boolean): string =>
    urlBearing || ABSOLUTE_URL_PATTERN.test(value.trim())
        ? hostOf(value.trim())
        : truncateForStorage(scrubSecrets(value));

const sanitizeRunLogValue = (value: unknown, urlBearing: boolean, depth: number, seen: Set<object>): unknown => {
    if (value === null || value === undefined) {
        // JSON has no undefined, and a key that silently disappears reads as a
        // field the caller never passed.
        return null;
    }
    if (typeof value === 'string') {
        return sanitizeRunLogString(value, urlBearing);
    }
    if (typeof value === 'number') {
        // NaN and ±Infinity have no JSON representation; JSON.stringify would
        // store `null` and lose the fact that the caller passed a broken number.
        return Number.isFinite(value) ? value : RUN_LOG_UNSERIALIZABLE;
    }
    if (typeof value === 'boolean') {
        return value;
    }
    if (typeof value === 'bigint') {
        // Prisma returns a bigint for some columns and JSON.stringify throws on
        // one, which would abort the checkpoint write rather than log it.
        return String(value);
    }
    if (typeof value === 'function' || typeof value === 'symbol') {
        return RUN_LOG_UNSERIALIZABLE;
    }
    if (value instanceof Error) {
        const normalized = safeError(value);
        // Rebuilt field by field rather than spread, so a member added to
        // SafeErrorFields later cannot reach this column without being
        // considered here. `code` and `status` are already bounded closed
        // values, so neither needs truncating.
        return {
            name: truncateForStorage(normalized.name),
            ...(normalized.code === undefined ? {} : { code: normalized.code }),
            ...(normalized.status === undefined ? {} : { status: normalized.status }),
        };
    }
    if (value instanceof Date) {
        // Recursed as a plain object a Date has no own keys and would serialise
        // to `{}`, silently losing the timestamp.
        const time = value.getTime();
        return Number.isFinite(time) ? value.toISOString() : RUN_LOG_UNSERIALIZABLE;
    }
    if (depth >= RUN_LOG_MAX_FIELD_DEPTH) {
        return RUN_LOG_UNSERIALIZABLE;
    }

    const container = value as object;
    // `seen` tracks the current path only — it is cleared on the way out — so a
    // node shared by two branches survives while a true cycle is caught before
    // it can recurse forever.
    if (seen.has(container)) {
        return RUN_LOG_UNSERIALIZABLE;
    }
    seen.add(container);
    try {
        if (Array.isArray(value)) {
            const kept = value
                .slice(0, RUN_LOG_MAX_ARRAY_ENTRIES)
                .map((member): unknown => sanitizeRunLogValue(member, urlBearing, depth + 1, seen));
            // The marker carries the dropped count (a number this module
            // computed, never caller content) so the log says it was truncated
            // instead of quietly reading as a shorter array.
            return value.length > RUN_LOG_MAX_ARRAY_ENTRIES
                ? [...kept, `${RUN_LOG_TRUNCATED} ${value.length - RUN_LOG_MAX_ARRAY_ENTRIES} more`]
                : kept;
        }

        const record = container as Record<string, unknown>;
        const output: Record<string, unknown> = {};
        for (const key of Object.keys(record)) {
            if (key === UNSAFE_COUNT_KEY) {
                continue;
            }
            // Redaction by key name comes FIRST and replaces the value whatever
            // its type: a credential nested under `credentials: {...}` must not
            // be recursed into and partially preserved.
            output[truncateForStorage(scrubSecrets(key))] = isSecretBearingKey(key)
                ? RUN_LOG_REDACTED
                : sanitizeRunLogValue(record[key], urlBearing || isUrlBearingKey(key), depth + 1, seen);
        }
        return output;
    } catch {
        // A throwing getter or an exotic host object is a caller problem, never
        // a reason to abandon the checkpoint write.
        return RUN_LOG_UNSERIALIZABLE;
    } finally {
        seen.delete(container);
    }
};

const runLogTimestamp = (at: Date): string => {
    if (!(at instanceof Date)) {
        return RUN_LOG_INVALID_TIMESTAMP;
    }
    const time = at.getTime();
    return Number.isFinite(time) ? at.toISOString() : RUN_LOG_INVALID_TIMESTAMP;
};

// Exported for the same reason mergeCounts, appendCappedLog and toCatalogRun are
// (§1.2): it is a pure decision the unit suite under src/__tests__ can pin with
// no database, and every rule in the contract above is a rule someone could get
// wrong. It is the only way an entry reaches the `log` column — appendRunLog and
// finishRun both go through it.
export const sanitizeRunLogEntry = (
    entry: { event: string } & Record<string, unknown>,
    at: Date,
): Record<string, unknown> => {
    // Written first so they also come first in the stored object (the order
    // operators read), and re-asserted by skipping any caller key that collides.
    const sanitized: Record<string, unknown> = {
        [RUN_LOG_AT_KEY]: runLogTimestamp(at),
        [RUN_LOG_EVENT_KEY]:
            typeof entry?.event === 'string' && entry.event.length > 0
                ? truncateForStorage(scrubSecrets(entry.event))
                : // Mirrors safeError's 'UnknownError' fallback: the declared
                  // type does not bind a JavaScript caller, and an entry with no
                  // event is still worth storing.
                  RUN_LOG_UNKNOWN_EVENT,
    };

    if (!isPlainRecord(entry)) {
        return sanitized;
    }

    // Seeded with the entry itself so a self-referencing field is caught at the
    // first hop rather than one level in.
    const seen = new Set<object>([entry as object]);

    for (const key of Object.keys(entry)) {
        const safeKey = truncateForStorage(scrubSecrets(key));
        if (safeKey === RUN_LOG_AT_KEY || safeKey === RUN_LOG_EVENT_KEY || key === UNSAFE_COUNT_KEY) {
            continue;
        }
        sanitized[safeKey] = isSecretBearingKey(key)
            ? RUN_LOG_REDACTED
            : sanitizeRunLogValue(entry[key], isUrlBearingKey(key), 1, seen);
    }

    return sanitized;
};

// The single row -> domain mapper (§6): snake_case to camelCase, with real
// defaults instead of optionals the caller has to guess about. No other function
// in this module hand-assembles a CatalogRun.
export const toCatalogRun = <TCursor>(row: unknown): CatalogRun<TCursor> => {
    const record = isPlainRecord(row) ? row : {};

    return {
        id: typeof record.id === 'string' ? record.id : '',
        // kind and status are PRESERVED, never coerced onto a known member.
        // Rewriting the kind of a run this module did not open would corrupt the
        // operator's audit trail, which is worse than surfacing an unfamiliar
        // value; and since every reader here filters both columns in SQL, an
        // unrecognised value can only reach this mapper for a row a caller
        // fetched itself.
        kind: record.kind as CatalogRunKind,
        status: record.status as CatalogRunStatus,
        manifestVersion: typeof record.manifest_version === 'string' ? record.manifest_version : '',
        // started_at is NOT NULL with a database default, so the fallback is
        // unreachable for any row read through this module. It exists so the
        // mapper is total — it never throws — and the epoch is deliberately
        // unmistakable as a real run time if it ever surfaces.
        startedAt: toDateOrNull(record.started_at) ?? new Date(0),
        finishedAt: toDateOrNull(record.finished_at),
        // SQL NULL and a JSON literal null both land here, and both mean "no
        // checkpoint yet". The cast is the one price of the generic: the shape
        // belongs to the caller that saved it.
        cursor: record.cursor === null || record.cursor === undefined ? null : (record.cursor as TCursor),
        // Reuses the merge so "what counts as a counter map" is defined exactly
        // once; merging an empty delta normalises the stored value and defaults
        // it to {}.
        counts: mergeCounts(record.counts, {}),
    };
};

// The stage lock's decisions, exported and pure for the same reason the merge
// and the log cap are (§1.2): each is a rule someone could get wrong, and every
// one of them is checkable with no database.

/**
 * The mode a stage takes the catalog-graph lock in.
 *
 * Unknown names default to `exclusive`, which is the safe direction: a stage
 * this table has not heard of is assumed to write, so it waits for the mutators
 * instead of running beside one.
 */
export const catalogStageLockMode = (stage: CatalogStageName): CatalogStageLockMode =>
    CATALOG_STAGE_LOCK_MODES[stage] ?? 'exclusive';

/**
 * The advisory-lock functions a mode maps onto.
 *
 * `try` first in every case — the lock refuses rather than blocks (see
 * acquireCatalogStageLock) — and the unlock must MATCH the acquisition: calling
 * `pg_advisory_unlock` on a lock taken with `pg_advisory_lock_shared` releases
 * nothing and warns, so a mismatched pair would hold the graph until the process
 * exited. Pairing them here is what keeps that impossible.
 */
export const catalogStageLockFunctions = (
    mode: CatalogStageLockMode,
): { readonly tryLock: string; readonly unlock: string } =>
    mode === 'shared'
        ? { tryLock: 'pg_try_advisory_lock_shared', unlock: 'pg_advisory_unlock_shared' }
        : { tryLock: 'pg_try_advisory_lock', unlock: 'pg_advisory_unlock' };

/**
 * The key every catalog stage contends on: one class id, one object name for the
 * whole graph (see CATALOG_GRAPH_LOCK_NAME and CATALOG_STAGE_LOCK_CLASS_ID).
 *
 * It takes no stage argument on purpose — that is the rule, not an omission. The
 * object id is `hashtext(objectName)` computed in PostgreSQL rather than here,
 * so the value this pipeline locks on is the one PostgreSQL's own hash produces
 * for that name.
 */
export const catalogStageLockKey = (): { readonly classId: number; readonly objectName: string } => ({
    classId: CATALOG_STAGE_LOCK_CLASS_ID,
    objectName: CATALOG_GRAPH_LOCK_NAME,
});

/** Refuse-immediately is the default: an unbounded wait is what an operator cannot see. */
const CATALOG_STAGE_LOCK_DEFAULT_WAIT_MS = 0;

/** Long enough that polling costs nothing on an hours-long stage, short enough to feel prompt. */
const CATALOG_STAGE_LOCK_DEFAULT_POLL_MS = 500;

/**
 * How long acquisition may wait, as a number of milliseconds it can act on.
 *
 * Every shape a caller can pass is given an explicit meaning rather than
 * collapsing into one, exactly as appendCappedLog's cap is: a negative or
 * non-numeric request becomes the refuse-immediately default (`NaN` compares
 * false against everything and would otherwise fall through as "wait forever"),
 * and `Infinity` is deliberately NOT honoured — no catalog stage may block
 * forever on a lock an operator cannot see, so it is capped at the ceiling
 * below.
 */
const CATALOG_STAGE_LOCK_MAX_WAIT_MS = 3_600_000;

export const normalizeStageLockWaitMs = (waitMs: number | undefined): number => {
    if (typeof waitMs !== 'number' || Number.isNaN(waitMs) || waitMs <= 0) {
        return CATALOG_STAGE_LOCK_DEFAULT_WAIT_MS;
    }
    return Math.min(Math.floor(Math.min(waitMs, CATALOG_STAGE_LOCK_MAX_WAIT_MS)), CATALOG_STAGE_LOCK_MAX_WAIT_MS);
};

/** The poll interval, floored at 1 ms so a misconfigured 0 cannot become a busy loop. */
export const normalizeStageLockPollMs = (pollIntervalMs: number | undefined): number => {
    if (typeof pollIntervalMs !== 'number' || !Number.isFinite(pollIntervalMs) || pollIntervalMs < 1) {
        return CATALOG_STAGE_LOCK_DEFAULT_POLL_MS;
    }
    return Math.floor(pollIntervalMs);
};

// ---------------------------------------------------------------------------
// I/O recipes (§5). Every function takes the injected `db` first and targets a
// single run by its primary key.
//
// WHY THERE IS NO OWNER PREDICATE HERE. Rule §1.5/§5.1 requires the owner key in
// every where clause, including updates and deletes. `catalog_import_runs` is
// the sanctioned exception: it is shared reference data with no user_id column by
// design. prisma/schema.prisma says so at the model itself ("they hold shared
// reference data, carry no user_id, and are the only authenticated reads without
// a tenant predicate. Adding an owner column here would be a mistake, not a
// fix"), and the Agent Action Plan §0.5.1 states the same. There is no tenant to
// scope to, and no request-scoped identity ever reaches this module — it runs
// only from operator CLI entry points, never from an HTTP handler.
//
// The compensating control is scripts/lib/dbGuard.ts, which every script imports
// immediately after bootstrap.ts and BEFORE any Prisma client exists: it
// classifies DATABASE_URL as development, test, shadow or unknown, refuses an
// unknown origin outright, and requires an explicit `--confirm-target <dbname>`
// before catalog-load.ts or recipes-seed.ts may write catalog data into a
// non-development database. Scoping is therefore enforced at the database
// boundary rather than the row: the guard decides *which database* a run may be
// written to, and the primary key decides *which row*.
// ---------------------------------------------------------------------------

// A Prisma transaction client is exactly the client with $transaction removed
// (Prisma's ITXClientDenyList), so its absence is a reliable probe for "the
// caller already owns a transaction". Used by every locking write below to wrap
// its read-modify-write when — and only when — we own the connection; opening a
// transaction inside the caller's would nest, which Prisma does not support.
const transactionRunnerOf = (db: CatalogRunDb): PrismaClient | null => {
    const candidate = db as PrismaClient;
    return typeof candidate.$transaction === 'function' ? candidate : null;
};

// The one place that decides "new transaction or the caller's". Every locking
// write goes through it, so the two client shapes never diverge in behaviour:
// with the singleton we open one interactive transaction and the locks are
// released at its commit; with an injected `tx` we run in place and the locks
// are held until the CALLER commits — which is exactly what catalog-load.ts
// wants, since its release verification and this checkpoint write must succeed
// or fail together.
const inRunTransaction = async <T>(db: CatalogRunDb, work: (tx: CatalogRunDb) => Promise<T>): Promise<T> => {
    const runner = transactionRunnerOf(db);
    return runner ? runner.$transaction((tx) => work(tx)) : work(db);
};

// A syntactically valid uuid, checked before any $queryRaw below binds `id`.
// The raw statements cast the parameter with `::uuid` (the column is @db.Uuid
// and a template parameter binds as text), and Postgres answers a malformed
// value with a 22P02 invalid-input error that Prisma surfaces as its own error
// class — a vendor error shape this module must neither leak nor pattern-match
// (§8/§9). Prisma's own findUnique rejects a malformed id too, so turning that
// case into this module's typed `run_not_found` is a single shared improvement
// rather than a behaviour regression: an id that cannot identify a row is
// exactly "no such run".
const RUN_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const assertWellFormedRunId = (runId: string): void => {
    if (typeof runId !== 'string' || !RUN_ID_PATTERN.test(runId)) {
        throw new CheckpointError('run_not_found', runId);
    }
};

// The row lock every JSONB read-modify-write and every close takes first.
//
// Prisma cannot express FOR UPDATE, so this is raw SQL by necessity — it is also
// the only lock that works: `counts` and `log` are JSONB maps that have to be
// read, merged in application code and written back (see mergeCounts), and two
// unlocked writers of that pair silently lose one side's update. The lock is
// held for the life of the surrounding transaction (see inRunTransaction), so
// concurrent checkpoint writers queue on the row instead of overwriting each
// other, and a reader that arrives after the close sees the settled status.
//
// JSONB columns come back already parsed; `mergeCounts` and `appendCappedLog`
// tolerate any shape, so no assertion about their contents is needed here. An
// empty array means the id is well formed but no such run exists.
interface LockedRunState {
    status: string;
    counts: unknown;
    log: unknown;
}

const lockRunForUpdate = async (db: CatalogRunDb, runId: string): Promise<LockedRunState | null> => {
    const rows = await db.$queryRaw<LockedRunState[]>`
        SELECT status, counts, log FROM catalog_import_runs WHERE id = ${runId}::uuid FOR UPDATE
    `;

    return rows.length > 0 ? rows[0] : null;
};

// The claim lock for openOrResumeRun, and the reason a run can be claimed at all
// without a new unique constraint.
//
// There is no row to lock before the claim — that is the whole problem: two
// invocations for the same (kind, manifest_version) both find no resumable run
// and both create one, after which two processes own the same work, duplicate
// every USDA and OpenRouter call it costs, and race each other's cursor. A
// transaction alone does not prevent it (neither insert conflicts with the
// other), so the serialisation point has to be a lock on the IDENTITY rather
// than on a row.
//
// This mirrors the Agent Action Plan's own idiom for the request path
// (`SELECT pg_advisory_xact_lock(hashtext('meal-planning:' || userId))`, §0.5.1
// "Lock first"), applied to the pipeline's identity instead of a user's. The key
// is composed as one string parameter so the whole value is bound rather than
// interpolated. hashtext narrows to 32 bits, so two unrelated keys can collide:
// the only consequence is that one claim waits for the other's transaction, which
// is a few milliseconds once per stage.
//
// $executeRaw, not $queryRaw: pg_advisory_xact_lock returns void, and Prisma's
// query path fails to deserialise a void column (P2010). The lock is released
// when the surrounding transaction ends — the one we open, or the caller's when
// it injected a `tx` (see inRunTransaction).
const acquireRunClaimLock = async (
    db: CatalogRunDb,
    kind: CatalogRunKind,
    manifestVersion: string,
): Promise<void> => {
    const key = `catalog-run:${kind}:${manifestVersion}`;
    await db.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${key}))`;
};

// Runs on the failure path only, so the happy path never pays for this read. It
// exists because the guarded writes below scope on `status` as well as `id`: a
// zero row count means either the run is gone or it is closed, and those are
// different operator mistakes (see CheckpointError).
const classifyUnwritableRun = async (db: CatalogRunDb, runId: string): Promise<CheckpointErrorCode> => {
    const row = await db.catalog_import_runs.findUnique({
        where: { id: runId },
        select: { id: true },
    });
    return row ? 'run_not_open' : 'run_not_found';
};

export const openRun = async <TCursor>(
    db: CatalogRunDb,
    input: { kind: CatalogRunKind; manifestVersion: string; cursor?: TCursor; logger?: ScriptLogger },
): Promise<CatalogRun<TCursor>> => {
    const data: Prisma.catalog_import_runsCreateInput = {
        kind: input.kind,
        manifest_version: input.manifestVersion,
        status: RUN_STATUS_RUNNING,
        // Written as an empty map and an empty array rather than left NULL so
        // that no reader — here or in the report scripts — needs a null branch.
        //
        // The asymmetry that makes this worth stating: Prisma writes JavaScript
        // `null` into a Json column as the JSON *literal* null, and only
        // Prisma.DbNull produces a SQL NULL. This module never needs DbNull,
        // because it only ever sets a cursor and never clears one — when the
        // caller has no starting checkpoint, `cursor` is simply left absent
        // below, which stores SQL NULL on a nullable column. That also keeps the
        // generated client a type-only import, since DbNull is a runtime value.
        counts: {},
        log: [],
    };

    if (input.cursor !== undefined) {
        // The one cast the generic costs us: TCursor is the caller's shape and
        // Prisma wants InputJsonValue. It is stored and returned verbatim.
        data.cursor = input.cursor as Prisma.InputJsonValue;
    }

    // started_at is deliberately not set: the column's database default is the
    // authoritative start time, so a run's clock never depends on the script
    // host's.
    const row = await db.catalog_import_runs.create({ data });
    const run = toCatalogRun<TCursor>(row);

    input.logger?.info('run_opened', {
        runId: run.id,
        kind: run.kind,
        manifestVersion: run.manifestVersion,
    });

    return run;
};

// Only a 'running' row is RESUMABLE, and that is a narrower question than "is
// there a run for this stage": a row closed as 'failed' or 'succeeded' is not
// resumable but still OWNS the batch keys it opened, because
// catalog_generation_batches.batch_key is unique across the table (see the model
// comment in prisma/schema.prisma). openOrResumeRun therefore consults this
// function first and the terminal history second — never this function alone —
// and the reason is spelled out in THE CLAIM below.
export const findResumableRun = async <TCursor>(
    db: CatalogRunDb,
    input: { kind: CatalogRunKind; manifestVersion: string },
): Promise<CatalogRun<TCursor> | null> => {
    // kind + status + newest-first is what the (kind, started_at) index exists
    // for. Manifest version is part of the match because a run only resumes
    // against the same input it started from — a new manifest is new work, not a
    // continuation. Newest first because an operator who launched a stage twice
    // can leave more than one open run, and resuming the latest is the only
    // deterministic choice.
    const row = await db.catalog_import_runs.findFirst({
        where: {
            kind: input.kind,
            manifest_version: input.manifestVersion,
            status: RUN_STATUS_RUNNING,
        },
        orderBy: { started_at: 'desc' },
    });

    return row ? toCatalogRun<TCursor>(row) : null;
};

// The newest run for this identity WHATEVER its status, which is how the claim
// sees the terminal history a resumable-only read is blind to. Ordered the same
// way as findResumableRun, so "newest" means the same thing in both and the
// newest attempt is what decides.
const findLatestRun = async <TCursor>(
    db: CatalogRunDb,
    input: { kind: CatalogRunKind; manifestVersion: string },
): Promise<CatalogRun<TCursor> | null> => {
    const row = await db.catalog_import_runs.findFirst({
        where: { kind: input.kind, manifest_version: input.manifestVersion },
        orderBy: { started_at: 'desc' },
    });

    return row ? toCatalogRun<TCursor>(row) : null;
};

// Continues a run that was closed as 'failed', instead of opening a second run
// beside it.
//
// WHY A RETRY CONTINUES THE SAME ROW. A failed stage's batch rows survive its
// closure, and `batch_key` is unique across catalog_generation_batches, so a new
// run could never reserve a model call under a key the failed run opened —
// budget.ts would refuse it, correctly, because charging another run's row would
// corrupt that run's totals. Continuing the row is therefore not a convenience:
// it is the only transition under which a retry can address its own batches at
// all. What it does NOT have to buy back is the allowance: budget.ts caps spend
// per coverage-plan BUDGET SCOPE, summed across every run in it, so the failed
// attempt's reservations are not forgiven by reopening the row and would not
// have been escaped by a fresh one either. `counts`, `cursor` and the batch
// ledger are preserved so the retry picks up at the recorded checkpoint rather
// than re-deriving one.
//
// This is the one transition out of a terminal status, and it is deliberately
// not part of finishRun: THE TERMINAL-TRANSITION RULE forbids a teardown
// REWRITING a settled outcome (succeeded becoming failed or the reverse), and
// nothing here rewrites an outcome — the run is explicitly reopened for a new
// attempt, under the same row lock, with the previous attempt's failure entry
// still in `log` and a `run_retried` entry appended beside it. The status
// predicate on the write is what keeps the two apart: only a stored 'failed' can
// be reopened, so a concurrent close or a second retry cannot slip through.
const retryFailedRun = async <TCursor>(
    db: CatalogRunDb,
    runId: string,
    at: Date,
): Promise<CatalogRun<TCursor>> => {
    const locked = await lockRunForUpdate(db, runId);

    if (!locked) {
        throw new CheckpointError('run_not_found', runId);
    }
    if (locked.status !== RUN_STATUS_FAILED) {
        // Cast for the same reason closeRunOnce casts: an unfamiliar stored
        // status is reported as found rather than normalised away.
        throw new CheckpointError('run_already_finished', runId, locked.status as CatalogRunStatus);
    }

    // finished_at goes back to null because the run is open again and that column
    // is what every reader uses to tell an open run from a settled one —
    // getActiveReleaseLoad falls back to started_at, and a row that claimed both
    // 'running' and a finish time would be a contradiction an operator has to
    // resolve by hand. The log entry is written in the SAME statement as the
    // status change, exactly as closeRunOnce writes its failure entry, so the
    // reopening and its record cannot be separated.
    const log = appendCappedLog(locked.log, sanitizeRunLogEntry({ event: 'run_retried' }, at), RUN_LOG_MAX_ENTRIES);

    const result = await db.catalog_import_runs.updateMany({
        where: { id: runId, status: RUN_STATUS_FAILED },
        data: {
            status: RUN_STATUS_RUNNING,
            finished_at: null,
            log: log as Prisma.InputJsonValue,
        },
    });

    // Unreachable while this transaction holds the row lock; kept as the
    // guarantee itself rather than as a comment (see closeRunOnce).
    if (result.count === 0) {
        throw new CheckpointError(await classifyUnwritableRun(db, runId), runId);
    }

    const row = await db.catalog_import_runs.findUnique({ where: { id: runId } });

    if (!row) {
        throw new CheckpointError('run_not_found', runId);
    }

    return toCatalogRun<TCursor>(row);
};

// THE CLAIM. This is the only entry point the four scripts use, and it is an
// atomic claim rather than a find-then-create: the advisory lock is taken FIRST,
// so the find and the create are one indivisible step for a given
// (kind, manifest_version). Exactly one concurrent caller creates the run; every
// other caller blocks on the lock, then finds the row the winner committed and
// resumes it. Without the lock both callers see "nothing resumable" and both
// create.
//
// FOUR OUTCOMES, NOT TWO, AND THE BATCH LEDGER IS WHY. `batch_key` is unique
// across catalog_generation_batches, so the batches a stage opens belong to that
// run for good and no later run can reserve a model call under them. A claim
// that answered "nothing running, so open a fresh row" would therefore hand the
// operator a run that cannot reserve anything the previous attempt had already
// opened, and the visible symptom would be a budget error in place of a rerun.
// The claim consequently looks at the terminal history too:
//   * a 'running' row            -> resumed, from its own cursor and remaining budget;
//   * a 'failed' row             -> RETRIED, by continuing that same row (retryFailedRun);
//   * a 'succeeded' row          -> returned as `alreadyCompleted`, with NO write
//                                   of any kind, because the work it records is done
//                                   and its ledger is settled;
//   * nothing at all             -> a fresh run.
// `alreadyCompleted` is the caller's signal to stop rather than to work: a stage
// that ignores it and reserves anyway is refused by budget.ts, which requires an
// open run (requireOpenRun), so the failure is typed and nothing is spent — but
// the intended shape is `if (claim.alreadyCompleted) { report and exit 0 }`.
// Re-running a completed stage is not how new candidates are produced; a new
// coveragePlanVersion is, and it brings batch keys of its own.
//
// WHAT THIS GUARANTEES, PRECISELY, AND WHAT IT DOES NOT.
//
// It guarantees exactly one run row per (kind, manifest_version), and therefore
// that every concurrent invocation converges on the SAME run. That convergence
// is load-bearing well beyond tidiness, though NOT because the spend cap
// depends on it: budget.ts caps spend per coverage-plan BUDGET SCOPE, summed
// across every run in it, so a second run row would draw on the same allowance
// rather than on one of its own. What one row does buy is the rest of the run's
// bookkeeping — `counts` and `log` accumulate under the row lock without loss
// instead of being split across two histories of one stage, the terminal
// transition (see THE TERMINAL-TRANSITION RULE) settles the outcome once, and
// every batch key stays addressable by the run that opened it, which is what
// lets a retry work its own batches (see retryFailedRun).
//
// It does NOT, ON ITS OWN, grant exclusive processing for the run's lifetime,
// and the two promises are kept by two different mechanisms in this module. THE
// CLAIM guarantees ONE RUN ROW: its advisory lock is transaction-scoped, so it
// is released when this short claim commits, and after that two processes
// launched against the same stage both hold a handle to the same run and can
// both work through it. THE STAGE LOCK guarantees ONE WRITER:
// acquireCatalogStageLock holds a SESSION-scoped advisory lock on the whole
// catalog graph, on a dedicated connection, for as long as the stage runs — and
// it is what the CLI entry points now take, which is why a second launch of a
// mutating stage is refused at its entry point instead of racing this one. Do
// not merge the two descriptions: a caller that holds the stage lock still needs
// the claim (to converge on one run row, and so on one ledger and one cursor),
// and a caller that holds the claim still needs the lock (to be the only
// writer), so neither subsumes the other.
//
// Why this claim cannot be the lock, which is also why the lock lives where it
// does:
//   * A durable claim (an owner id plus a lease expiry on the run row, taken by
//     compare-and-set and reasserted as work proceeds) needs columns
//     catalog_import_runs does not have, i.e. a schema change, and a periodic
//     reassertion, i.e. the background timer the Agent Action Plan (§0.8.2)
//     excludes from this feature.
//   * A session-scoped lock (pg_advisory_lock, held from claim to teardown)
//     needs one pinned connection for the run's whole lifetime. This function is
//     handed a POOLED client it must neither construct nor pin (see the
//     type-only import above), and Prisma routes each statement to whichever
//     pooled connection is free, so a session lock taken THROUGH `db` would be
//     held by an arbitrary connection and could never be released
//     deterministically. acquireCatalogStageLock therefore opens its OWN
//     connection with `pg` and holds the lock there (see THE STAGE LOCK).
// What is left of the residual cost of a double launch, now that entry points
// take the lock: the lock is what prevents it, and the claim is still not
// evidence of it. Do not re-add a justification here claiming this claim makes a
// second writer impossible — it makes a second run ROW impossible, which is a
// different and smaller promise, and the difference matters to anyone reading
// this to decide whether a new caller needs the lock as well (it does).
export const openOrResumeRun = async <TCursor>(
    db: CatalogRunDb,
    input: {
        kind: CatalogRunKind;
        manifestVersion: string;
        initialCursor?: TCursor;
        logger?: ScriptLogger;
        now?: () => Date;
        /**
         * Whether continuing an unfinished run under this key is permitted.
         *
         * Optional, and an absent value permits it — which is this function's
         * long-standing behaviour and what the two callers that do not expose a
         * `--resume` flag (validation, release load) rely on.
         *
         * `false` is the opt-out a caller that DOES expose the flag passes when
         * the operator did not use it, which is what `catalog-import-usda.ts`
         * and `catalog-generate-ai.ts` both pass. Without this parameter the
         * flag could not mean anything: those scripts parsed `--resume`, and an
         * unfinished run was continued either way, so their usage lines
         * ("Default: off") described behaviour no code implemented. Refusing is
         * the only coherent reading of "not asked to resume" — see THE CLAIM:
         * runs are keyed by (kind, manifestVersion) so that a repeat recognises
         * completed work, so a second run row for the same key is not a thing
         * this module can create, and silently continuing is what the flag was
         * meant to make explicit.
         *
         * A run that already SUCCEEDED is unaffected: recognising it and doing
         * no work is not a resume, and it is what makes a repeat import or
         * generation incapable of creating duplicates.
         */
        resume?: boolean;
    },
): Promise<CatalogRunClaim<TCursor>> => {
    // Injected and defaulted like appendRunLog's, so the retry entry's timestamp
    // is testable without freezing the system clock, and read inside the
    // transaction so it is the moment the reopening is written.
    const now = input.now ?? ((): Date => new Date());

    const claimed = await inRunTransaction(db, async (tx): Promise<CatalogRunClaim<TCursor>> => {
        await acquireRunClaimLock(tx, input.kind, input.manifestVersion);

        const resumable = await findResumableRun<TCursor>(tx, {
            kind: input.kind,
            manifestVersion: input.manifestVersion,
        });

        if (resumable) {
            if (input.resume === false) {
                throw new CheckpointError('run_resume_not_requested', resumable.id, RUN_STATUS_RUNNING);
            }
            return { run: resumable, resumed: true, alreadyCompleted: false };
        }

        // Nothing is running, so the terminal history decides — see THE CLAIM.
        const latest = await findLatestRun<TCursor>(tx, {
            kind: input.kind,
            manifestVersion: input.manifestVersion,
        });

        if (latest?.status === RUN_STATUS_SUCCEEDED) {
            return { run: latest, resumed: false, alreadyCompleted: true };
        }

        if (latest) {
            // Any terminal status other than 'succeeded' is a failed attempt, and
            // retryFailedRun refuses anything it does not recognise rather than
            // reopening it blindly.
            //
            // A failed run is unfinished work too — its cursor is the whole
            // reason retrying it is cheap — so `resume: false` refuses it on the
            // same terms as a running one rather than reopening it silently.
            if (input.resume === false) {
                throw new CheckpointError(
                    'run_resume_not_requested',
                    latest.id,
                    (latest.status as CatalogRunStatus) ?? RUN_STATUS_FAILED,
                );
            }
            const retried = await retryFailedRun<TCursor>(tx, latest.id, now());
            return { run: retried, resumed: true, alreadyCompleted: false };
        }

        // The logger is deliberately NOT passed down: openRun would print
        // 'run_opened' before this transaction commits, and a claim that rolled
        // back afterwards would leave a line claiming a run exists. The
        // equivalent line is emitted below, after the commit, with the same
        // event and fields.
        const run = await openRun<TCursor>(tx, {
            kind: input.kind,
            manifestVersion: input.manifestVersion,
            cursor: input.initialCursor,
        });

        return { run, resumed: false, alreadyCompleted: false };
    });

    // One line per outcome, all after the commit, so nothing printed here can
    // describe a claim that rolled back.
    if (claimed.alreadyCompleted) {
        input.logger?.info('run_already_completed', {
            runId: claimed.run.id,
            kind: claimed.run.kind,
            manifestVersion: claimed.run.manifestVersion,
            finishedAt: claimed.run.finishedAt,
        });
    } else if (claimed.resumed) {
        // The cursor is logged, not just the id: on a resumed or retried run this
        // line is the operator's only visible answer to "where does it pick up?".
        input.logger?.info('run_resumed', { runId: claimed.run.id, cursor: claimed.run.cursor });
    } else {
        input.logger?.info('run_opened', {
            runId: claimed.run.id,
            kind: claimed.run.kind,
            manifestVersion: claimed.run.manifestVersion,
        });
    }

    return claimed;
};

// The guard budget.ts takes before it inserts a batch row, and the reason a
// reservation against a run that does not exist is a typed error rather than a
// raw Prisma failure.
//
// catalog_generation_batches.run_id is a NOT NULL foreign key, so inserting a
// batch for an unknown run id is refused by PostgreSQL and surfaces as Prisma's
// P2003 — a vendor error shape neither module may pattern-match (§9) and one no
// caller can act on. Reading the row first turns that into CheckpointError,
// which names the run and says whether it is missing or closed; `FOR UPDATE` is
// what makes the answer durable rather than advisory, because a concurrent
// DELETE of the parent run must then wait for the caller's transaction and
// cannot invalidate the check between here and the insert.
//
// Requiring the run to be OPEN, not merely to exist, is the other half: a
// settled run's ledger is finished evidence, and adding a reservation to it
// would corrupt the record of what that run spent.
//
// Callers must be inside a transaction for the lock to mean anything — budget.ts
// calls this inside the transaction that holds its budget-scope lock.
export const requireOpenRun = async (db: CatalogRunDb, runId: string): Promise<void> => {
    assertWellFormedRunId(runId);

    const locked = await lockRunForUpdate(db, runId);

    if (!locked) {
        throw new CheckpointError('run_not_found', runId);
    }
    if (locked.status !== RUN_STATUS_RUNNING) {
        throw new CheckpointError('run_not_open', runId);
    }
};

const writeCursorToRun = async <TCursor>(db: CatalogRunDb, runId: string, cursor: TCursor): Promise<void> => {
    // The same LOCKING read the two JSONB merges and the close take, so that
    // EVERY write to a run row goes through the row lock without exception.
    //
    // The cursor is not a read-modify-write — it replaces the column with a
    // value the caller computed — so the lock is not protecting an earlier read
    // here. It is protecting the invariant: the previous revision of this file
    // left this one statement unlocked and justified it by claiming
    // openOrResumeRun's claim "guarantees a single owner per run". That claim
    // guarantees a single run ROW (see THE CLAIM), which is not the same thing
    // as a single live writer, so the justification was wrong and the exception
    // it licensed is gone. With the lock, two writers of one run serialise into
    // a defined order instead of racing, and the status is read under the lock
    // that the write is then guarded on.
    //
    // What the lock still cannot decide is WHICH cursor is newer: ordering that
    // would mean interpreting the caller's opaque resume key, which this module
    // never does by design. Two live writers therefore remain last-write-wins,
    // whose worst case is a cursor moved backwards and work repeated — and the
    // pipeline's writes are idempotent by design (upsert on source_key for the
    // catalog, slug for recipes), so repeated work costs time rather than
    // correctness. Preventing two live writers at all is a lifetime-ownership
    // question that belongs above this module (see THE CLAIM).
    const locked = await lockRunForUpdate(db, runId);

    if (!locked) {
        throw new CheckpointError('run_not_found', runId);
    }
    if (locked.status !== RUN_STATUS_RUNNING) {
        throw new CheckpointError('run_not_open', runId);
    }

    // updateMany rather than update because it reports a count instead of
    // throwing Prisma's P2025 when the guarded where matches nothing. Reacting to
    // P2025 would mean pattern-matching a vendor error shape (§9) and would
    // require a runtime import of the generated client, which the type-only
    // import above deliberately rules out.
    const result = await db.catalog_import_runs.updateMany({
        where: { id: runId, status: RUN_STATUS_RUNNING },
        data: { cursor: cursor as Prisma.InputJsonValue },
    });

    // Unreachable while the row lock is held; kept as the guarantee itself
    // rather than as a comment (see closeRunOnce).
    if (result.count === 0) {
        throw new CheckpointError('run_not_open', runId);
    }
};

export const saveCursor = async <TCursor>(db: CatalogRunDb, runId: string, cursor: TCursor): Promise<void> => {
    assertWellFormedRunId(runId);

    // Called after every manifest batch, generation batch and verified release
    // file — the hottest write in the module — which is why the locked section
    // is one read and one write and nothing else.
    await inRunTransaction(db, (tx) => writeCursorToRun(tx, runId, cursor));
};

const mergeCountsIntoRun = async (
    db: CatalogRunDb,
    runId: string,
    delta: Record<string, number>,
): Promise<Readonly<Record<string, number>>> => {
    // The LOCKING read. Everything this function then does depends on the value
    // it just read, so the row must not change underneath it.
    const locked = await lockRunForUpdate(db, runId);

    if (!locked) {
        throw new CheckpointError('run_not_found', runId);
    }
    if (locked.status !== RUN_STATUS_RUNNING) {
        throw new CheckpointError('run_not_open', runId);
    }

    const counts = mergeCounts(locked.counts, delta);

    const result = await db.catalog_import_runs.updateMany({
        where: { id: runId, status: RUN_STATUS_RUNNING },
        data: { counts },
    });

    // Unreachable while the row lock is held; kept as the guarantee itself
    // rather than as a comment (see closeRunOnce).
    if (result.count === 0) {
        throw new CheckpointError('run_not_open', runId);
    }

    return counts;
};

export const recordCounts = async (
    db: CatalogRunDb,
    runId: string,
    delta: Record<string, number>,
): Promise<Readonly<Record<string, number>>> => {
    assertWellFormedRunId(runId);

    // Accumulating into a JSONB map is unavoidably a read-modify-write (see
    // mergeCounts: Prisma cannot increment a key inside a JSONB column, so the
    // addition happens in application code).
    //
    // WHY THE ROW LOCK IS NOT OPTIONAL. A transaction alone does not serialise
    // two read-modify-writes: both can read `counts` at the same value, both add
    // their own delta to it, and the second write erases the first — a lost
    // update, in the column an operator reads to decide whether a release is
    // complete. `SELECT … FOR UPDATE` inside the transaction is what makes the
    // pair atomic, so concurrent writers queue on the row and every delta lands.
    // Concurrency here is real rather than hypothetical: budget.ts mirrors its
    // model-call totals through this same function while a stage records its own
    // progress, and an operator can run two stages against one run's row.
    return inRunTransaction(db, (tx) => mergeCountsIntoRun(tx, runId, delta));
};

const writeCheckpointToRun = async <TCursor>(
    db: CatalogRunDb,
    runId: string,
    cursor: TCursor,
    delta: Record<string, number>,
): Promise<Readonly<Record<string, number>>> => {
    // ONE locking read, ONE write. That is the whole point of this function: the
    // cursor and the counts for the work it names move together or not at all.
    const locked = await lockRunForUpdate(db, runId);

    if (!locked) {
        throw new CheckpointError('run_not_found', runId);
    }
    if (locked.status !== RUN_STATUS_RUNNING) {
        throw new CheckpointError('run_not_open', runId);
    }

    const counts = mergeCounts(locked.counts, delta);

    const result = await db.catalog_import_runs.updateMany({
        where: { id: runId, status: RUN_STATUS_RUNNING },
        data: { cursor: cursor as Prisma.InputJsonValue, counts },
    });

    // Unreachable while the row lock is held; kept as the guarantee itself
    // rather than as a comment (see closeRunOnce).
    if (result.count === 0) {
        throw new CheckpointError('run_not_open', runId);
    }

    return counts;
};

/**
 * Advances the cursor and adds this unit of work's counts in ONE statement
 * under ONE row lock — and, when handed a transaction, inside the caller's.
 *
 * WHY THIS EXISTS BESIDE `saveCursor` AND `recordCounts`. Those two are each
 * their own transaction, so a stage that called both recorded the work and the
 * place it had reached as two separate commits. Between them a crash leaves the
 * run saying it processed N items while its cursor names the item before them:
 * a resume then redoes work the counts already claim, and the counts are wrong
 * for the rest of the run's life. That is not a lost update the row lock can
 * prevent — each write is individually correct — it is two facts about one unit
 * of work that were never atomic.
 *
 * Worse, neither of them can join the CALLER's transaction usefully on its own:
 * a stage whose real work is a batch of catalog rows wants the rows, the cursor
 * and the counts to commit together, so that a rolled-back batch leaves a run
 * ledger that never mentioned it. `inRunTransaction` runs in place when handed
 * a `tx` (see the note above it), so passing the batch's transaction client
 * here is what makes the three one commit.
 *
 * `saveCursor` and `recordCounts` are unchanged and still exported: a caller
 * with only one of the two to write — the budget ledger mirroring model-call
 * totals, a release load recording verified files — should not have to invent
 * the other, and an empty `counts` here is a legitimate cursor-only checkpoint.
 *
 * Returns the merged counts, as `recordCounts` does, so a caller can log what
 * the run now says without reading the row again.
 */
export const saveCheckpoint = async <TCursor>(
    db: CatalogRunDb,
    runId: string,
    input: { readonly cursor: TCursor; readonly counts?: Record<string, number> },
): Promise<Readonly<Record<string, number>>> => {
    assertWellFormedRunId(runId);

    return inRunTransaction(db, (tx) => writeCheckpointToRun(tx, runId, input.cursor, input.counts ?? {}));
};

const appendLogToRun = async (
    db: CatalogRunDb,
    runId: string,
    entry: { event: string } & Record<string, unknown>,
    at: Date,
): Promise<void> => {
    // The same LOCKING read as mergeCountsIntoRun, for the same reason:
    // appending to a JSONB array is a read-modify-write, and two unlocked
    // appenders each write an array missing the other's entry. Losing a log
    // entry is quieter than losing a count and costs an operator the one record
    // of what a stage did.
    const locked = await lockRunForUpdate(db, runId);

    if (!locked) {
        throw new CheckpointError('run_not_found', runId);
    }
    if (locked.status !== RUN_STATUS_RUNNING) {
        throw new CheckpointError('run_not_open', runId);
    }

    // Sanitized BEFORE it is appended, never after: what reaches the column is
    // the storage-safe entry, and `at`/`event` are this module's values rather
    // than the caller's (see THE STORAGE SECURITY CONTRACT OF THE RUN LOG).
    const log = appendCappedLog(locked.log, sanitizeRunLogEntry(entry, at), RUN_LOG_MAX_ENTRIES);

    const result = await db.catalog_import_runs.updateMany({
        where: { id: runId, status: RUN_STATUS_RUNNING },
        data: { log: log as Prisma.InputJsonValue },
    });

    // Unreachable while the row lock is held; kept as the guarantee itself
    // rather than as a comment (see closeRunOnce).
    if (result.count === 0) {
        throw new CheckpointError('run_not_open', runId);
    }
};

export const appendRunLog = async (
    db: CatalogRunDb,
    runId: string,
    entry: { event: string } & Record<string, unknown>,
    now: () => Date = () => new Date(),
): Promise<void> => {
    assertWellFormedRunId(runId);

    // `now` is injected (and defaulted) so the retention behaviour is testable
    // without freezing the system clock. It is read inside the transaction, so
    // the recorded moment is the moment the entry is written rather than the
    // moment the caller queued behind the row lock.
    await inRunTransaction(db, (tx) => appendLogToRun(tx, runId, entry, now()));
};

// Reads the closed row back for the mapper while the row lock is still held, so
// what the caller receives is the committed state rather than a value this
// module assembled from its own inputs (§6 — toCatalogRun is the only mapper).
const readRunForMapping = async (db: CatalogRunDb, runId: string): Promise<CatalogRun> => {
    const row = await db.catalog_import_runs.findUnique({ where: { id: runId } });

    // Unreachable while the transaction holds the row lock, and this pipeline
    // never deletes run rows (they are small, retained indefinitely, and cascade
    // only with the release batches). Kept because the alternative to a typed
    // error here is a non-null assertion that would lie if either fact changed.
    if (!row) {
        throw new CheckpointError('run_not_found', runId);
    }

    return toCatalogRun(row);
};

// THE TERMINAL-TRANSITION RULE.
//
// A run is closed exactly once. Only a run whose STORED status is 'running' may
// be written, the status is read under a row lock and the write itself is
// guarded on that status, so a duplicate teardown cannot rewrite a settled
// outcome. Two things make that non-negotiable rather than tidy:
//
//   * The active catalog release is defined as the newest 'release_load' run
//     with status 'succeeded' (see the note on RELEASE_LOAD_RUN_KIND). Flipping
//     a failed load to 'succeeded' would publish a release whose checksums or
//     row counts never verified; flipping a succeeded one to 'failed' would
//     silently deactivate a good release. Both are release-safety incidents, not
//     bookkeeping errors.
//   * `input.counts` are MERGED BY ADDITION (see mergeCounts), so re-running the
//     close would add the caller's final totals to the row a second time.
//
// What the previous tolerance was right about is kept: a teardown path that runs
// twice (an error handler plus a `finally`) must not raise a second error that
// masks the first. So an IDENTICAL replay — the stored status already equals the
// requested one — returns the stored row unchanged, with no write and no second
// merge of `input.counts`. A CONFLICTING replay is rejected with a typed
// `run_already_finished` carrying the stored status, because there is no
// interpretation of it that is safe to guess at.
const closeRunOnce = async (
    db: CatalogRunDb,
    runId: string,
    status: 'succeeded' | 'failed',
    input?: { counts?: Record<string, number>; error?: unknown },
): Promise<CatalogRun> => {
    const locked = await lockRunForUpdate(db, runId);

    if (!locked) {
        throw new CheckpointError('run_not_found', runId);
    }

    if (locked.status !== RUN_STATUS_RUNNING) {
        if (locked.status === status) {
            return readRunForMapping(db, runId);
        }
        // Cast, not coercion: toCatalogRun preserves an unfamiliar status rather
        // than rewriting it, and an error reporting the value it actually found
        // is worth more to an operator than one that normalised it away.
        throw new CheckpointError('run_already_finished', runId, locked.status as CatalogRunStatus);
    }

    const counts = mergeCounts(locked.counts, input?.counts ?? {});

    const data: Prisma.catalog_import_runsUpdateManyMutationInput = {
        status,
        finished_at: new Date(),
        counts,
    };

    if (status === 'failed') {
        // safeError, never the raw error object (§8). A value thrown in this
        // pipeline routinely carries a DATABASE_URL with its password, a USDA
        // URL with api_key in the query string, or an OpenRouter bearer token,
        // and `log` is read by operators and copied into committed reports. The
        // stack and the error object itself never leave safeError.
        //
        // Written in the SAME statement as the status change rather than through
        // appendRunLog, for two reasons: the failure record and the closure must
        // not be separable, and appendRunLog requires an open run — which this
        // write is in the act of ending.
        //
        // safeError FIRST, then the sanitizer: safeError is what discards a
        // non-Error thrown value wholesale (a thrown string carrying a
        // connection URL becomes 'Unknown error'), and the sanitizer then caps
        // and re-scrubs what is left, so both log writers in this module store
        // entries under exactly the same rules.
        const failureEntry = sanitizeRunLogEntry(
            { event: 'run_failed', error: safeError(input?.error) },
            new Date(),
        );
        data.log = appendCappedLog(locked.log, failureEntry, RUN_LOG_MAX_ENTRIES) as Prisma.InputJsonValue;
    }

    // The status predicate is defence in depth: while this transaction holds the
    // row lock no other writer can close the run, so a zero count is
    // unreachable. It stays because it is the guarantee itself — if the lock were
    // ever lost, this predicate, not a comment, is what keeps a second close from
    // landing. updateMany rather than update so the miss is a count instead of
    // Prisma's P2025, which this module must not pattern-match (§9).
    const result = await db.catalog_import_runs.updateMany({
        where: { id: runId, status: RUN_STATUS_RUNNING },
        data,
    });

    if (result.count === 0) {
        throw new CheckpointError(await classifyUnwritableRun(db, runId), runId);
    }

    return readRunForMapping(db, runId);
};

export const finishRun = async (
    db: CatalogRunDb,
    runId: string,
    status: 'succeeded' | 'failed',
    input?: { counts?: Record<string, number>; error?: unknown; logger?: ScriptLogger },
): Promise<CatalogRun> => {
    assertWellFormedRunId(runId);

    // Lock, decide and write in one transaction. Two concurrent teardowns of the
    // same run therefore serialise: the first closes it, the second sees the
    // settled status and either replays it or is rejected.
    const run = await inRunTransaction(db, (tx) => closeRunOnce(tx, runId, status, input));

    // Logged after the transaction returns, so a line claiming a run was closed
    // is only ever printed for a close that actually committed.
    //
    // For catalog-load.ts this call IS the active-release mechanism: marking a
    // run 'failed' is precisely what leaves the previous release active, because
    // getActiveReleaseLoad only ever considers 'succeeded' rows. A load that
    // verified its checksums but found the row counts disagreeing with the
    // manifest therefore needs no compensating write and no pointer rollback —
    // it simply never becomes the newest succeeded release_load run.
    input?.logger?.info('run_finished', { runId: run.id, status: run.status, counts: run.counts });

    return run;
};

export const getActiveReleaseLoad = async (
    db: CatalogRunDb,
): Promise<{ releaseId: string; loadedAt: Date; runId: string } | null> => {
    // The newest succeeded release load, over the (kind, started_at) index. This
    // is the query src/services/catalog.service.ts::getStatus must mirror — see
    // the note on RELEASE_LOAD_RUN_KIND for why it is duplicated rather than
    // imported.
    const row = await db.catalog_import_runs.findFirst({
        where: { kind: RELEASE_LOAD_RUN_KIND, status: RUN_STATUS_SUCCEEDED },
        orderBy: { started_at: 'desc' },
    });

    if (!row) {
        return null;
    }

    const run = toCatalogRun(row);

    return {
        // manifest_version CARRIES THE RELEASE ID for a release_load run — 'v1'
        // for data/meal-planning/catalog/releases/v1. It is the value
        // GET /api/catalog/status reports as `catalogRelease`, so it is a
        // published contract rather than an internal label, and the release
        // scripts must keep writing the release id into that column.
        releaseId: run.manifestVersion,
        // finishRun sets status and finished_at in one statement, so a succeeded
        // run always has one; started_at is a fallback that keeps the API's
        // `lastLoadedAt` non-null rather than a case that occurs.
        loadedAt: run.finishedAt ?? run.startedAt,
        runId: run.id,
    };
};

// ---------------------------------------------------------------------------
// THE STAGE LOCK.
//
// One writer at a time on the catalog graph, for the whole lifetime of a stage
// process. This is the guarantee THE CLAIM above explicitly does not make, and
// the reason it cannot is stated there: a transaction-scoped lock dies with the
// short claim transaction, and a session-scoped one cannot be taken through the
// injected Prisma client because Prisma hands out POOLED connections and routes
// each statement to whichever is free. So this lock is taken on a connection
// this module opens itself, with `pg`, and holds until release() closes it.
//
// WHY `pg` AND WHY IT IS REQUIRED LAZILY. `pg` is already a runtime dependency
// of this service (Prisma's own driver) and needs no addition; @types/pg is
// deliberately absent, so the narrow interfaces below declare exactly the three
// calls this file makes, which is the established in-repo precedent
// (src/__tests__/setup/testDb.ts, src/__tests__/api/compat.test.ts and
// src/__tests__/api/catalogCollation.test.ts all declare their own PgClient the
// same way). The require lives INSIDE the opener rather than at module load,
// for the same reason the Prisma import above is type-only: importing
// checkpoint.ts must stay side-effect-free, so a suite that only reads the pure
// decisions never loads a database driver.
//
// WHAT HOLDS AND WHAT DOES NOT. A PostgreSQL session advisory lock needs no
// renewal — there is no lease to reassert, which is what makes it usable without
// the background timer the Agent Action Plan (§0.8.2) excludes — but it is held
// by the CONNECTION, so a dropped connection releases it. `keepAlive` is
// therefore on, and the layers beneath it are what keep a lost lock from being a
// corrupted catalog: the run claim still converges on one run row, and the
// writing stages still take row locks and write under version predicates
// (catalog-validate.ts's per-food compare-and-set is the one to read), so the
// worst case is duplicated work rather than a stale judgement landing on a
// changed row.
// ---------------------------------------------------------------------------

interface PgQueryResult<TRow> {
    rows: TRow[];
}

/**
 * The connection a stage lock is held on: three calls, which is all this module
 * makes of it. Exported so a caller can inject one (see `openConnection`) and
 * drive every branch of acquisition with no database.
 */
export interface CatalogStageLockConnection {
    connect(): Promise<void>;
    query<TRow = Record<string, unknown>>(text: string, values?: readonly unknown[]): Promise<PgQueryResult<TRow>>;
    end(): Promise<void>;
}

interface PgModule {
    Client: new (config: {
        connectionString: string;
        application_name?: string;
        connectionTimeoutMillis?: number;
        query_timeout?: number;
        keepAlive?: boolean;
    }) => CatalogStageLockConnection;
}

/** A held stage lock. `release()` unlocks, closes the connection, and is safe to call twice. */
export interface CatalogStageLock {
    readonly stage: CatalogStageName;
    readonly mode: CatalogStageLockMode;
    release(): Promise<void>;
}

export interface CatalogStageLockInput {
    readonly stage: CatalogStageName;
    /** Defaults to the stage's own mode (CATALOG_STAGE_LOCK_MODES). */
    readonly mode?: CatalogStageLockMode;
    /**
     * How long to wait for a refused lock before throwing `catalog_stage_locked`.
     * Defaults to 0 — refuse at once — and is capped, because a stage waiting
     * forever on a lock is indistinguishable to an operator from a stage that
     * hung.
     */
    readonly waitMs?: number;
    readonly pollIntervalMs?: number;
    /** Defaults to DATABASE_URL, which lib/bootstrap.ts has already loaded from .env. */
    readonly connectionString?: string;
    readonly logger?: ScriptLogger;
    readonly now?: () => Date;
    readonly sleep?: (ms: number) => Promise<void>;
    /** Injectable so acquisition is testable without PostgreSQL. */
    readonly openConnection?: () => CatalogStageLockConnection;
}

/** Ten seconds: a stage lock that cannot reach the database should say so, not hang. */
const STAGE_LOCK_CONNECT_TIMEOUT_MS = 10_000;

/** The lock statements are single function calls; anything slower is a database in trouble. */
const STAGE_LOCK_QUERY_TIMEOUT_MS = 30_000;

/**
 * Names this connection in pg_stat_activity, so an operator who finds the graph
 * locked can attribute it to a stage rather than to an anonymous idle session.
 */
const STAGE_LOCK_APPLICATION_NAME = 'soh-catalog-stage-lock';

const resolveStageLockConnectionString = (input: CatalogStageLockInput): string => {
    const candidate = input.connectionString ?? process.env.DATABASE_URL;

    if (typeof candidate !== 'string' || candidate.trim().length === 0) {
        // Typed rather than left to the driver: `new Client({connectionString:
        // undefined})` reads the libpq environment instead and can connect
        // somewhere nobody named (§9 — config is resolved behind an accessor that
        // fails loudly). dbGuard normally refuses this at module load, so
        // reaching here means a caller bypassed it.
        throw new CheckpointError('catalog_stage_lock_unavailable', '', undefined, {
            stage: input.stage,
            mode: input.mode ?? catalogStageLockMode(input.stage),
            waitedMs: 0,
        });
    }

    return candidate;
};

const openStageLockConnection = (connectionString: string): CatalogStageLockConnection => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires -- lazy by design: see the note above
    const pg = require('pg') as PgModule;

    return new pg.Client({
        connectionString,
        application_name: STAGE_LOCK_APPLICATION_NAME,
        connectionTimeoutMillis: STAGE_LOCK_CONNECT_TIMEOUT_MS,
        query_timeout: STAGE_LOCK_QUERY_TIMEOUT_MS,
        // The session sits idle for the hours a stage takes, and the lock lives
        // in that session: without keepalive probes an idle connection can be
        // dropped by the network and the lock released with nobody informed.
        keepAlive: true,
    });
};

const defaultSleep = (ms: number): Promise<void> =>
    new Promise((resolve) => {
        setTimeout(resolve, ms);
    });

interface StageLockHandleInput {
    readonly stage: CatalogStageName;
    readonly mode: CatalogStageLockMode;
    readonly connection: CatalogStageLockConnection;
    readonly unlock: string;
    readonly classId: number;
    readonly objectName: string;
    readonly logger?: ScriptLogger;
}

/**
 * The handle acquisition returns.
 *
 * `release()` NEVER THROWS, and that is deliberate: it is called from a
 * `finally` (see withCatalogStageLock), so an error raised here would replace
 * the stage's own failure with a teardown failure. A failed unlock is logged and
 * left alone, because the session lock is released by the connection closing and
 * — if even that fails — by the process exiting. It is also idempotent: the
 * second call returns without touching a connection the first one closed.
 */
const buildStageLock = (input: StageLockHandleInput): CatalogStageLock => {
    let released = false;

    return {
        stage: input.stage,
        mode: input.mode,
        release: async (): Promise<void> => {
            if (released) {
                return;
            }
            // Set BEFORE the statements, so a failure cannot leave the handle
            // looking unreleased and invite a retry against a broken connection.
            released = true;

            try {
                await input.connection.query(`SELECT ${input.unlock}($1::int4, hashtext($2::text))`, [
                    input.classId,
                    input.objectName,
                ]);
            } catch (error) {
                input.logger?.warn('catalog_stage_unlock_failed', {
                    stage: input.stage,
                    mode: input.mode,
                    error: safeError(error),
                });
            }

            try {
                await input.connection.end();
            } catch (error) {
                input.logger?.warn('catalog_stage_lock_close_failed', {
                    stage: input.stage,
                    mode: input.mode,
                    error: safeError(error),
                });
            }

            input.logger?.info('catalog_stage_lock_released', { stage: input.stage, mode: input.mode });
        },
    };
};

/**
 * Takes the catalog graph's stage lock and returns a handle that releases it.
 *
 * Refuses rather than blocks by default: `pg_try_advisory_lock*` is attempted
 * first, and on refusal acquisition either polls for up to `waitMs` on the
 * injected sleep or throws `CheckpointError('catalog_stage_locked')` naming the
 * stage and the mode. There is no branch in which it waits indefinitely.
 *
 * The connection, the clock and the sleep are all injectable, so every branch —
 * granted, refused, waited-then-granted, waited-then-refused, released twice —
 * is reachable without a database.
 */
export const acquireCatalogStageLock = async (input: CatalogStageLockInput): Promise<CatalogStageLock> => {
    const stage = input.stage;
    const mode = input.mode ?? catalogStageLockMode(stage);
    const { classId, objectName } = catalogStageLockKey();
    const { tryLock, unlock } = catalogStageLockFunctions(mode);
    const waitMs = normalizeStageLockWaitMs(input.waitMs);
    const pollIntervalMs = normalizeStageLockPollMs(input.pollIntervalMs);
    const now = input.now ?? ((): Date => new Date());
    const sleep = input.sleep ?? defaultSleep;

    const connection = input.openConnection
        ? input.openConnection()
        : openStageLockConnection(resolveStageLockConnectionString(input));

    // Closes without raising: this runs on paths that are already failing, and a
    // teardown error here would replace the reason acquisition failed with a
    // reason nobody asked about.
    const closeQuietly = async (): Promise<void> => {
        try {
            await connection.end();
        } catch (error) {
            input.logger?.warn('catalog_stage_lock_close_failed', { stage, mode, error: safeError(error) });
        }
    };

    try {
        await connection.connect();
    } catch (error) {
        await closeQuietly();
        throw error;
    }

    const startedAt = now().getTime();
    // A second, clock-independent bound on the loop. The elapsed-time check
    // below is the real deadline, but it reads an INJECTED clock: a caller whose
    // fake clock never advances would otherwise poll forever. One attempt per
    // poll interval plus the first is exactly how many the deadline allows.
    const maxAttempts = Math.ceil(waitMs / pollIntervalMs) + 1;
    let attempts = 0;

    try {
        for (;;) {
            // Two-integer keyspace, and the object id is hashtext() computed in
            // PostgreSQL — see CATALOG_STAGE_LOCK_CLASS_ID for why this must
            // never be the one-argument form. Both values are BOUND, not
            // interpolated, so the statement text is constant.
            const attempt = await connection.query<{ locked: boolean | null }>(
                `SELECT ${tryLock}($1::int4, hashtext($2::text)) AS locked`,
                [classId, objectName],
            );
            attempts += 1;

            if (attempt.rows[0]?.locked === true) {
                const waitedMs = now().getTime() - startedAt;
                input.logger?.info('catalog_stage_lock_acquired', { stage, mode, waitedMs, attempts });
                return buildStageLock({ stage, mode, connection, unlock, classId, objectName, logger: input.logger });
            }

            const waitedMs = now().getTime() - startedAt;
            const remainingMs = waitMs - waitedMs;

            if (remainingMs <= 0 || attempts >= maxAttempts) {
                await closeQuietly();
                throw new CheckpointError('catalog_stage_locked', '', undefined, { stage, mode, waitedMs });
            }

            if (attempts === 1) {
                // Once, on the first refusal. Polling a one-hour wait every half
                // second would otherwise write 7,200 identical lines into the
                // operator's terminal; the acquisition line reports the total
                // wait and the attempt count when it finally succeeds.
                input.logger?.info('catalog_stage_lock_waiting', { stage, mode, waitMs, pollIntervalMs });
            }
            await sleep(Math.min(pollIntervalMs, remainingMs));
        }
    } catch (error) {
        if (isThrownInstanceOf(error, CheckpointError) && error.code === 'catalog_stage_locked') {
            // Already closed on the refusal path above; closing twice would log
            // a driver complaint for no diagnostic gain.
            throw error;
        }
        await closeQuietly();
        throw error;
    }
};

/**
 * Runs `work` while holding the stage lock, and releases it in a `finally`.
 *
 * This is what a CLI entry point calls. The lock is taken before any of the
 * stage's own work and released after it whatever the outcome, so the window it
 * covers is exactly the process's writing lifetime — which is the guarantee THE
 * CLAIM cannot make on its own.
 */
export const withCatalogStageLock = async <T>(
    input: CatalogStageLockInput,
    work: (lock: CatalogStageLock) => Promise<T>,
): Promise<T> => {
    const lock = await acquireCatalogStageLock(input);

    try {
        return await work(lock);
    } finally {
        await lock.release();
    }
};
