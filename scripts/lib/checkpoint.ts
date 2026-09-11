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
//     CLAIM for what that does and does not promise — it bounds the damage of a
//     double launch, it does not make one impossible, and the difference is
//     stated there rather than glossed here.
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
import { hostOf, isSecretBearingKey, safeError, scrubSecrets, ScriptLogger } from './logger';

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

// Not exported: the open and failed statuses are this module's internal
// lifecycle detail, whereas the two constants above are a contract shared with
// src/ and the runbook.
const RUN_STATUS_RUNNING: CatalogRunStatus = 'running';
const RUN_STATUS_FAILED: CatalogRunStatus = 'failed';

export type CheckpointErrorCode = 'run_not_found' | 'run_not_open' | 'run_already_finished';

// Kept as a function rather than inline in the constructor so a third code
// could be added without disturbing the two messages that already exist: both
// are byte-identical to what this module has always thrown, because they reach
// operator terminals and the committed reports.
const checkpointErrorMessage = (
    code: CheckpointErrorCode,
    runId: string,
    storedStatus?: CatalogRunStatus,
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
    return `Catalog run ${runId} is no longer open`;
};

// Follows the DailyQuotaError template in src/services/entitlement.service.ts:
// a named class carrying the data the caller needs rather than a string (§8).
// The three codes are worth distinguishing because they mean different operator
// mistakes — a run id that no longer exists (wrong database, wrong environment),
// a checkpoint written into a run that was already closed (a script that lost
// track of its own run, which would otherwise corrupt a finished record), and a
// second teardown trying to close an already-terminal run as the OTHER status
// (`run_already_finished`, which finishRun refuses because it would rewrite a
// settled outcome — see the transition rule there).
//
// `storedStatus` is optional so every existing two-argument construction in this
// module and its callers keeps compiling and keeps producing the same message;
// only the conflicting-transition path passes it.
export class CheckpointError extends Error {
    constructor(
        public readonly code: CheckpointErrorCode,
        public readonly runId: string,
        public readonly storedStatus?: CatalogRunStatus,
    ) {
        super(checkpointErrorMessage(code, runId, storedStatus));
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
//   * An Error becomes safeError's {name, message}: never the object, never the
//     stack, never a `cause` (§8).
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
        return {
            name: truncateForStorage(normalized.name),
            message: truncateForStorage(normalized.message),
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
// leave this run's cap unenforced. Continuing the row is therefore not a
// convenience: it is the only transition under which a retry can address its own
// batches at all. It also carries the right budget semantics, which a fresh run
// would get wrong in the expensive direction: `counts`, `cursor` and the batch
// ledger are preserved, so the retry picks up at the recorded checkpoint and
// spends against what is LEFT of CATALOG_MODEL_CALL_BUDGET rather than receiving
// a second full allowance for money the failed attempt already spent.
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
// is load-bearing well beyond tidiness: budget.ts's spend cap is enforced as
// SUM(model_calls_reserved) over one run's batch rows, so two competing run rows
// would give an operator's single CATALOG_MODEL_CALL_BUDGET two independent
// allowances and double the money it caps. Converged on one run, the cap binds
// across every invocation, `counts` and `log` accumulate under the row lock
// without loss, and the terminal transition (see THE TERMINAL-TRANSITION RULE)
// settles the outcome once.
//
// It does NOT grant exclusive processing for the run's lifetime. The advisory
// lock is transaction-scoped, so it is released when this short claim commits;
// after that, two processes launched against the same stage both hold a handle
// to the same run and can both work through it. The residual cost of that is
// bounded rather than corrupting — the cap still holds, no count or log entry is
// lost, the outcome cannot be rewritten, and the pipeline's own writes are
// idempotent (upsert on source_key for catalog foods, slug for recipes), so the
// waste is repeated work rather than wrong data — but it is real, and this
// module cannot close it:
//   * A durable claim (an owner id plus a lease expiry on the run row, taken by
//     compare-and-set and reasserted as work proceeds) needs columns
//     catalog_import_runs does not have, i.e. a schema change, and a periodic
//     reassertion, i.e. the background timer the Agent Action Plan (§0.8.2)
//     excludes from this feature.
//   * A session-scoped lock (pg_advisory_lock, held from claim to teardown)
//     needs one pinned connection for the run's whole lifetime. This module is
//     handed a POOLED client it must neither construct nor pin (see the
//     type-only import above), and Prisma routes each statement to whichever
//     pooled connection is free, so a session lock taken here would be held by
//     an arbitrary connection and could never be released deterministically.
// That lock belongs to the CLI entry point, which owns its own process and can
// hold it for exactly as long as it works, and it is the entry points — not
// this module — that decide whether a second concurrent launch should wait or
// refuse. Until one of them does, treat "two launches of the same stage" as
// wasteful and not as unsafe, and do not re-add a justification here claiming
// this claim makes a second writer impossible: it makes a second run row
// impossible, which is a different and smaller promise.
export const openOrResumeRun = async <TCursor>(
    db: CatalogRunDb,
    input: {
        kind: CatalogRunKind;
        manifestVersion: string;
        initialCursor?: TCursor;
        logger?: ScriptLogger;
        now?: () => Date;
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
// calls this inside the transaction that holds its per-run budget lock.
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
