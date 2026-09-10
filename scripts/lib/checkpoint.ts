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
// TYPECHECKING NOTE: the type-only import below resolves to Prisma's generated
// client, which .gitignore excludes and which CI and the Docker build
// regenerate. `npx prisma generate` must therefore have run against the current
// prisma/schema.prisma before this file typechecks — a fresh checkout has no
// src/generated/prisma directory at all.

import { safeError, ScriptLogger } from './logger';

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

// Not exported: 'running' is this module's internal lifecycle detail, whereas
// the two constants above are a contract shared with src/ and the runbook.
const RUN_STATUS_RUNNING: CatalogRunStatus = 'running';

export type CheckpointErrorCode = 'run_not_found' | 'run_not_open';

// Follows the DailyQuotaError template in src/services/entitlement.service.ts:
// a named class carrying the data the caller needs rather than a string (§8).
// The two codes are worth distinguishing because they mean different operator
// mistakes — a run id that no longer exists (wrong database, wrong environment)
// versus a checkpoint written into a run that was already closed (a script that
// lost track of its own run, which would otherwise corrupt a finished record).
export class CheckpointError extends Error {
    constructor(
        public readonly code: CheckpointErrorCode,
        public readonly runId: string,
    ) {
        super(
            code === 'run_not_found'
                ? `Catalog run ${runId} does not exist`
                : `Catalog run ${runId} is no longer open`,
        );
        this.name = 'CheckpointError';
    }
}

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
export const appendCappedLog = (
    existing: unknown,
    entry: Record<string, unknown>,
    maxEntries: number,
): Record<string, unknown>[] => {
    const limit = Number.isFinite(maxEntries) ? Math.floor(maxEntries) : 0;
    if (limit < 1) {
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

    // Negative slice keeps the tail, which is the newest end — entries are always
    // appended.
    return entries.slice(-limit);
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
// caller already owns a transaction". Used by recordCounts to wrap its
// read-modify-write when — and only when — we own the connection; opening a
// transaction inside the caller's would nest, which Prisma does not support.
const transactionRunnerOf = (db: CatalogRunDb): PrismaClient | null => {
    const candidate = db as PrismaClient;
    return typeof candidate.$transaction === 'function' ? candidate : null;
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

export const openOrResumeRun = async <TCursor>(
    db: CatalogRunDb,
    input: { kind: CatalogRunKind; manifestVersion: string; initialCursor?: TCursor; logger?: ScriptLogger },
): Promise<{ run: CatalogRun<TCursor>; resumed: boolean }> => {
    const resumable = await findResumableRun<TCursor>(db, {
        kind: input.kind,
        manifestVersion: input.manifestVersion,
    });

    if (resumable) {
        // The cursor is logged, not just the id: on a resumed run this line is
        // the operator's only visible answer to "where does it pick up?".
        input.logger?.info('run_resumed', { runId: resumable.id, cursor: resumable.cursor });
        return { run: resumable, resumed: true };
    }

    const run = await openRun<TCursor>(db, {
        kind: input.kind,
        manifestVersion: input.manifestVersion,
        cursor: input.initialCursor,
        logger: input.logger,
    });

    return { run, resumed: false };
};

export const saveCursor = async <TCursor>(db: CatalogRunDb, runId: string, cursor: TCursor): Promise<void> => {
    // Called after every manifest batch, generation batch and verified release
    // file, so it stays one statement: no read, no merge, last write wins. The
    // cursor is the caller's own latest position, so there is nothing to
    // reconcile against what is stored.
    //
    // updateMany rather than update because it reports a count instead of
    // throwing Prisma's P2025 when the guarded where matches nothing. Reacting to
    // P2025 would mean pattern-matching a vendor error shape (§9) and would
    // require a runtime import of the generated client, which the type-only
    // import above deliberately rules out.
    const result = await db.catalog_import_runs.updateMany({
        where: { id: runId, status: RUN_STATUS_RUNNING },
        data: { cursor: cursor as Prisma.InputJsonValue },
    });

    if (result.count === 0) {
        throw new CheckpointError(await classifyUnwritableRun(db, runId), runId);
    }
};

const mergeCountsIntoRun = async (
    db: CatalogRunDb,
    runId: string,
    delta: Record<string, number>,
): Promise<Readonly<Record<string, number>>> => {
    const row = await db.catalog_import_runs.findUnique({
        where: { id: runId },
        select: { status: true, counts: true },
    });

    if (!row) {
        throw new CheckpointError('run_not_found', runId);
    }
    if (row.status !== RUN_STATUS_RUNNING) {
        throw new CheckpointError('run_not_open', runId);
    }

    const counts = mergeCounts(row.counts, delta);

    const result = await db.catalog_import_runs.updateMany({
        where: { id: runId, status: RUN_STATUS_RUNNING },
        data: { counts },
    });

    // Reachable only if the run was closed between the read and the write.
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
    const runner = transactionRunnerOf(db);

    // Accumulating into a JSONB map is unavoidably a read-modify-write (see
    // mergeCounts). When we own the connection the pair runs inside one
    // interactive transaction, so a crash between the read and the write cannot
    // leave a half-merged map on the row. When the caller passed its own
    // transaction client we run in place — nesting is not supported, and the
    // caller's transaction already provides the same atomicity.
    //
    // Worth being precise about what this does NOT buy: a transaction alone does
    // not serialise two concurrent read-modify-writes, so it is not lost-update
    // protection. It does not need to be — one script process owns a run at a
    // time (a run is found again and continued, never shared), so the only
    // writer of a given run row is the process that opened it. If that ever
    // changes, this needs a locking read, not a comment.
    return runner
        ? runner.$transaction((tx) => mergeCountsIntoRun(tx, runId, delta))
        : mergeCountsIntoRun(db, runId, delta);
};

export const appendRunLog = async (
    db: CatalogRunDb,
    runId: string,
    entry: { event: string } & Record<string, unknown>,
    now: () => Date = () => new Date(),
): Promise<void> => {
    const row = await db.catalog_import_runs.findUnique({
        where: { id: runId },
        select: { status: true, log: true },
    });

    if (!row) {
        throw new CheckpointError('run_not_found', runId);
    }
    if (row.status !== RUN_STATUS_RUNNING) {
        throw new CheckpointError('run_not_open', runId);
    }

    // `now` is injected (and defaulted) so the retention behaviour is testable
    // without freezing the system clock. Caller fields are spread last, so an
    // entry may override `at` if it is recording something that happened
    // earlier than the write.
    const log = appendCappedLog(row.log, { at: now().toISOString(), ...entry }, RUN_LOG_MAX_ENTRIES);

    const result = await db.catalog_import_runs.updateMany({
        where: { id: runId, status: RUN_STATUS_RUNNING },
        data: { log: log as Prisma.InputJsonValue },
    });

    if (result.count === 0) {
        throw new CheckpointError('run_not_open', runId);
    }
};

export const finishRun = async (
    db: CatalogRunDb,
    runId: string,
    status: 'succeeded' | 'failed',
    input?: { counts?: Record<string, number>; error?: unknown; logger?: ScriptLogger },
): Promise<CatalogRun> => {
    const existing = await db.catalog_import_runs.findUnique({
        where: { id: runId },
        select: { counts: true, log: true },
    });

    if (!existing) {
        throw new CheckpointError('run_not_found', runId);
    }

    // Closing is deliberately tolerant of a run that is already closed — unlike
    // the three in-flight writers above, which demand status = 'running'. A
    // teardown path that runs twice (an error handler plus a finally) must not
    // raise a second error that masks the first, and re-closing a run changes
    // nothing an operator relies on. Only a run that does not exist is worth
    // raising, because that means the caller is pointed at the wrong database.
    const counts = mergeCounts(existing.counts, input?.counts ?? {});

    const data: Prisma.catalog_import_runsUpdateInput = {
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
        const failureEntry = {
            at: new Date().toISOString(),
            event: 'run_failed',
            error: safeError(input?.error),
        };
        data.log = appendCappedLog(existing.log, failureEntry, RUN_LOG_MAX_ENTRIES) as Prisma.InputJsonValue;
    }

    // Existence was just established and this pipeline never deletes run rows
    // (they are small, retained indefinitely, and cascade only with the release
    // batches), so the unique update is safe here and returns the closed row for
    // the mapper.
    const row = await db.catalog_import_runs.update({ where: { id: runId }, data });
    const run = toCatalogRun(row);

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

