// Paces the catalog importer's USDA FoodData Central requests.
//
// The importer does not own its API key. `USDA_API_KEY` is the same key the
// running API uses on the request path — estimate grounding calls
// `searchGenericFoods` and `/api/macros/search-branded-foods` calls
// `searchBrandedFoods` — and USDA allows 1,000 requests per hour per key. An
// importer that saturates the key does not merely slow itself down: it
// degrades a live user feature. So the importer is capped at 900 per hour,
// leaving 100 per hour of headroom for that traffic, and when it runs out of
// allowance it PAUSES rather than failing (a multi-hour import that aborts on
// a full bucket would have to be restarted; one that waits simply finishes
// later, which is the whole point of the checkpointing around it).
//
// THOSE 900 ARE A CEILING, NOT A DEFAULT. `USDA_IMPORT_POLICY_CAP_PER_HOUR` is
// the import's own maximum and `USDA_VENDOR_CAP_PER_HOUR` is the vendor's, and
// the two are deliberately different numbers: configuration may LOWER the rate
// and nothing may raise it past the policy cap, because a run configured at the
// vendor's full 1,000 stays inside what the key allows while spending the live
// feature's share of it. A ceiling that only defaulted to 900 would be
// satisfied by `USDA_IMPORT_RATE_LIMIT_PER_HOUR=1000`, which is exactly the
// headroom this module exists to reserve being handed back by an environment
// variable.
//
// This module paces requests and reports what it paced (§1.1). It reads no
// manifest, touches no database, and decides nothing about catalog records.
// It deliberately does not import `usda.service.ts`: it gates transport, it
// never calls the vendor, and that module pulls in the Prisma client through
// `../prisma/client`. Vendor failures stay the vendor boundary's business —
// `UsdaError` is thrown and shaped by `usda.service.ts`, and nothing here
// catches or reshapes a USDA response (§9). The two errors this module owns are
// both about its own inputs: a configuration it cannot honour
// (`RateLimitConfigError`) and a durable ledger it cannot trust
// (`UsdaRateLedgerError`).
//
// Two gates enforce that cap, because a token bucket on its own cannot: it
// shapes the burst and paces smoothly, while an exact rolling-hour ledger of
// admitted attempts is what holds the run to `requestsPerHour` in ANY hour
// (see the derivation above `createUsdaRateLimiter`'s bounds check).
//
// WHY THAT LEDGER IS DURABLE AND NOT A VARIABLE. The hour the vendor counts
// belongs to the KEY, not to a process. `checkpoint.ts` grants no exclusive
// lifetime processing (its claim lock is transaction-scoped — read THE CLAIM
// there), so a stage can legitimately be resumed after an interruption and two
// launches of one stage can both work through the same run. A ledger living in
// a closure would start empty at each of those moments, and each process would
// hand itself a fresh 900: a restart inside the hour spends 1,800 against a cap
// of 1,000, and the headroom this module exists to reserve is gone while the
// live API takes the throttling. The ledger is therefore behind the
// `UsdaRateLedger` port, whose `reserve` DECIDES and RECORDS in one mutually
// excluded step, and the shipped default is a file-backed implementation that
// survives a restart and serialises concurrent processes.
//
// It is fail-CLOSED. An absent state file is a legitimate first run and reads
// as "nothing spent"; a state file that is present but cannot be trusted, a
// lock that cannot be taken or held exclusively, or a ledger directory that
// cannot be created stop the import with `UsdaRateLedgerError` rather than
// admitting an unpaced request. An import that stops loudly is restarted by an
// operator in a minute; a shared key throttled to zero degrades a user-facing
// feature until the hour rolls over.
//
// WHAT THE FILE LEDGER DOES NOT COVER. It is HOST-scoped: it serialises every
// importer that can see the same file, and by default every importer on the
// host does (read `defaultUsdaRateLedgerDirectory` for why the default is
// host-wide and not per-checkout). Two importers on two MACHINES sharing one
// API key are still not serialised against each other, and no
// filesystem-backed ledger can close that — neither process can see state that
// lives on the other's disk. The seam for closing it is this module's own
// `ledger` port: a `createDatabaseUsdaRateLedger` satisfying the same single
// `reserve` contract drops in through `UsdaRateLimiterOptions.ledger` with no
// other change here. What such a ledger needs is storage this module cannot
// create for itself — one shared rolling-window table of admitted attempts,
// which the Prisma schema does not define — so it is a schema proposal rather
// than something the limiter can arrange alone. Until that table exists the
// cross-host half of the cap is held by configuration, and the operating
// instruction is exactly that: run the importer from ONE host per rolling
// hour.
//
// The rate is a constructor argument, never an environment read inside the
// flow (§1.6/§5): `getUsdaImportRateLimitPerHour` is the single accessor that
// reads `USDA_IMPORT_RATE_LIMIT_PER_HOUR`, and it fails loudly (§9). This
// module reads NO other environment variable, `USDA_API_KEY` included — the
// ledger is keyed by a `scope` STRING the caller passes, which is why an
// operator importing under two different keys has to pass two distinct scopes
// (see `createFileUsdaRateLedger`). The rules worth getting wrong — the refill
// arithmetic, the wait computation, the rolling-hour ledger, the host match and
// the burst invariant — are pure and exported so they can be unit tested with
// no clock and no network (§1.2/§7.1), and both ledger implementations are
// built out of those same three window functions rather than a second copy of
// the arithmetic. `await sleep`, the `globalThis.fetch` patch and the file
// ledger's `fs` calls are the only impure parts. Jest's `roots` is
// `<rootDir>/src`, so no test file can live in this folder (§11); `now`,
// `sleep`, `logger` and the ledger itself are injected so a test can drive an
// hour of pacing instantly.
//
// Three Node builtins are imported — `fs` and `path` for the file ledger, and
// `os` for the host-wide directory its default path sits in — and nothing
// else. No dependency is added (AAP §0.4.2) and no timer runs in the
// background (AAP §0.8.2): the file lock is held only for the read-modify-write
// it protects and is never reasserted, so there is no lease to keep alive.
// Importing this module and constructing a limiter remain side-effect free —
// the ledger directory and the state file are created on the first `reserve`,
// not at construction.

import fs from 'fs';
import os from 'os';
import path from 'path';

import { hostOf, type ScriptLogger } from './logger';

/** The host every USDA FoodData Central request is sent to. */
export const USDA_HOST = 'api.nal.usda.gov';

/** USDA's published ceiling: 1,000 requests per hour per API key. */
export const USDA_VENDOR_CAP_PER_HOUR = 1000;

/**
 * The importer's OWN maximum: 900 per hour, whatever the vendor would allow.
 *
 * This is a product guarantee rather than a preference, and it is the reason
 * the two caps are separate constants. The vendor cap describes what the KEY
 * may spend; this one describes what the IMPORT may spend of it, and the 100
 * per hour between them are not slack — they are the allowance the running
 * API's `/api/macros/estimate`, `/api/macros/label-scan` and
 * `/api/macros/search-branded-foods` traffic draws on the SAME credential
 * (AAP §0.7.1 Group 1, §0.4.3). Configuring the import at the vendor's full
 * 1,000 does not overspend the key — it spends the live feature's share of it,
 * and the failure lands on a user request rather than on this run.
 *
 * So no configuration widens it. It is the bound
 * `getUsdaImportRateLimitPerHour` enforces on `USDA_IMPORT_RATE_LIMIT_PER_HOUR`
 * and the default `policyCapPerHour` every limiter is built with; a caller that
 * needs a LOWER ceiling passes one, and nothing may pass a higher one.
 */
export const USDA_IMPORT_POLICY_CAP_PER_HOUR = 900;

/**
 * The rate an import runs at when nothing is configured — the policy ceiling
 * itself, which is why it is expressed in terms of it rather than repeated as
 * a second 900 that could drift from it. The default IS the maximum here: the
 * import wants every request it is allowed, and the headroom it must leave is
 * already subtracted.
 */
export const DEFAULT_USDA_IMPORT_RATE_LIMIT_PER_HOUR = USDA_IMPORT_POLICY_CAP_PER_HOUR;

/** One USDA detail batch (`POST /foods` takes 20 ids) may go out back-to-back. */
export const DEFAULT_BURST_CAPACITY = 20;

const MS_PER_HOUR = 3_600_000;

/**
 * The window the hourly ceiling is measured over. USDA's limit is stated per
 * hour and it is a ROLLING hour, not a wall-clock one: there is no top of the
 * hour at which the vendor forgives what the importer already spent, so the
 * ledger measures the last `MS_PER_HOUR` from every attempt.
 */
export const RATE_WINDOW_MS = MS_PER_HOUR;

const RATE_LIMIT_ENV_VAR = 'USDA_IMPORT_RATE_LIMIT_PER_HOUR';

/**
 * A rate configuration that cannot be honoured. Thrown at startup, before any
 * request is paced, because every alternative is worse: silently halving the
 * pace wastes hours, and silently doubling it gets a key the live API depends
 * on throttled.
 *
 * The offending numbers travel on the error (§8) so a caller can report them
 * without re-parsing the message. They are `null` when the failure did not
 * involve that particular number.
 *
 * `vendorCapPerHour` carries the hourly ceiling the offending value was
 * measured against, which is the vendor's 1,000 for most rejections and
 * `USDA_IMPORT_POLICY_CAP_PER_HOUR` for the one rejection whose bound is the
 * import's own maximum. It is named for the common case and deliberately not
 * split into two fields: a caller reports the bound that was broken, and a
 * second field would let it report the one that was not.
 */
export class RateLimitConfigError extends Error {
    constructor(
        message: string,
        public readonly requestsPerHour: number | null = null,
        public readonly burstCapacity: number | null = null,
        public readonly vendorCapPerHour: number | null = null,
    ) {
        super(message);
        this.name = 'RateLimitConfigError';
    }
}

/**
 * Why a durable ledger could not be trusted. Each one is a refusal to pace
 * from state this module cannot vouch for, never a request that went out
 * unpaced.
 *
 * `state_absent` is deliberately NOT a code: a missing state file is a first
 * run and reads as "nothing spent". Everything below means the file, its lock
 * or its directory exists in a condition the ledger cannot reason about.
 *
 * `state_unparsable` covers a document that is not JSON, is not an object, or
 * whose attempt array holds anything but finite numbers — including the `null`
 * that `JSON.stringify` writes for a `NaN`, which is how a corrupted stamp
 * shows up on disk. `state_version_unsupported` is a document written by a
 * newer build whose shape this one may not reinterpret.
 * `state_scope_mismatch` means two different scopes resolved to one state file
 * (their file names collided after sanitising) or the file was hand-edited:
 * the ledger will not silently charge one credential's spend to another's
 * accounting.
 */
export type UsdaRateLedgerErrorCode =
    | 'state_directory_unusable'
    | 'state_unreadable'
    | 'state_unparsable'
    | 'state_version_unsupported'
    | 'state_scope_mismatch'
    | 'state_write_failed'
    | 'lock_unavailable';

/**
 * A durable ledger that cannot be trusted. Follows `RateLimitConfigError`'s
 * template (§8) — a named class carrying what a caller needs to report the
 * failure without re-parsing the message.
 *
 * The state path travels on the error and appears in the message on purpose,
 * because the operator's remedy is a decision about that exact file and they
 * cannot make it blind: deleting it forfeits the record of what this hour
 * already spent, so the next run starts from zero and can push the key past
 * USDA's 1,000/hour while the live API is using it. A path is not a secret —
 * but it is also never LOGGED (the log lines carry the ledger kind and scope
 * only), because a path can carry a home directory and the log is the artefact
 * that travels into CI output and committed reports.
 */
export class UsdaRateLedgerError extends Error {
    constructor(
        public readonly code: UsdaRateLedgerErrorCode,
        message: string,
        public readonly stateFilePath: string,
        public readonly scope: string,
    ) {
        super(message);
        this.name = 'UsdaRateLedgerError';
    }
}

/**
 * Which ledger paced a run. `process_local` is in-memory and durable across
 * nothing; `file` survives a restart and serialises the processes that share a
 * filesystem; `database` is reserved for the shared implementation the port
 * exists for, so adding it later needs no change to this union or to
 * `UsdaRequestStats`.
 */
export type UsdaRateLedgerKind = 'process_local' | 'file' | 'database';

/**
 * What a ledger is, for the report and the log. `scope` is the shared
 * credential's accounting scope — never the credential — so it is safe in both.
 */
export interface UsdaRateLedgerDescription {
    kind: UsdaRateLedgerKind;
    scope: string;
}

export interface UsdaRateLedgerReserveInput {
    nowMs: number;
    /** The hourly ceiling being enforced (`requestsPerHour`). */
    limit: number;
    /** The rolling window the ceiling is measured over (`RATE_WINDOW_MS`). */
    windowMs: number;
}

/**
 * The outcome of one reservation. `admitted` means a slot was RECORDED, not
 * merely that one was free — so a caller that does not go on to spend it has
 * over-charged the hour, which is the safe direction and the reason `acquire`
 * reserves only once it is about to fetch.
 *
 * `waitMs` is how long until the window has room, and is meaningful only when
 * `admitted` is false. `attemptsInWindow` is the ledger's own count for the
 * rolling window — including attempts made by other processes and by earlier
 * runs, which is the entire point of a durable ledger.
 */
export interface UsdaRateReservation {
    admitted: boolean;
    waitMs: number;
    attemptsInWindow: number;
}

/**
 * The rolling-hour ledger behind the limiter's binding gate.
 *
 * ONE method decides, and it both decides and records. That is a contract, not
 * a convenience: split into a load and a later save, two processes would each
 * read 899 and each admit, which is precisely the over-spend this port exists
 * to prevent. An implementation must therefore make the whole
 * read-prune-decide-record step mutually exclusive against every other process
 * that shares its state, and must reach its decision through the exported
 * `pruneAttemptWindow` / `windowWaitMs` / `recordAttemptWindow` rules so that
 * every ledger enforces the same rolling hour.
 *
 * `reserve` rejects rather than returning when the state backing it cannot be
 * trusted (`UsdaRateLedgerError`). Answering "admitted" from state it could not
 * read would be the one failure mode a rate ledger must not have.
 */
export interface UsdaRateLedger {
    reserve(input: UsdaRateLedgerReserveInput): Promise<UsdaRateReservation>;
    describe(): UsdaRateLedgerDescription;
}

/** A token bucket at an instant: whole-and-fractional tokens, and when they were counted. */
export interface BucketState {
    tokens: number;
    lastRefillMs: number;
}

/**
 * Physical USDA attempts split by the status class the vendor answered with.
 *
 * The limiter is the only place in the import that can count this. It gates
 * `globalThis.fetch`, so it sees every physical attempt — including the three
 * retries `usda.service.ts` may make inside one logical call, which its own
 * callers never learn about — and it holds the `Response` the delegate
 * returned, whose `status` is a header field that costs nothing to read and
 * does not touch or consume the body.
 *
 * The three statuses that get their own counter are the three the retry ladder
 * treats as transient, and they are counted EXACTLY rather than as a range:
 * `throttled429` is the vendor saying the key is over its hourly cap, which is
 * the one number that tells an operator this module's ceiling was set too high
 * or shared with something it does not know about; `timeout408` is the vendor
 * being slow; and `retryable400` is USDA's documented habit of rejecting a
 * request that succeeds when retried verbatim, which would otherwise be
 * indistinguishable from a malformed request in `otherClientError`. Lumping
 * the three into "4xx" is what made the previous report unable to answer "how
 * many 429s".
 */
export interface UsdaStatusClassCounts {
    /** 200-299. */
    ok2xx: number;
    /** Exactly 400 — retried verbatim by `usda.service.ts`, not a client defect. */
    retryable400: number;
    /** Exactly 408. */
    timeout408: number;
    /** Exactly 429 — the vendor refusing because the KEY is over its hourly cap. */
    throttled429: number;
    /** The rest of 4xx: 401/403 (a bad key) and 404 among them. */
    otherClientError: number;
    /** 500 and above. */
    serverError: number;
    /**
     * 1xx and 3xx, and any answer whose `status` is not a finite number — a
     * stub transport, or a runtime that resolved something that is not a
     * `Response`. Such an answer is still one attempt charged to the hour, so
     * it is counted rather than dropped: dropping it would break the
     * `attempts` identity on `UsdaRequestStats`, which is the only thing that
     * makes the reported split checkable.
     */
    otherStatus: number;
}

/**
 * What the limiter paced. `catalog-import-usda.ts` writes this verbatim into
 * `data/meal-planning/reports/latest/import-report.json` as the `usdaRequests`
 * block, which `catalog-report.ts` reconciles against the import half — so
 * these field names are a contract, they stay camelCase like the rest of the
 * reports, and no field here may carry a secret (no URLs, no key fragments,
 * no host beyond the configured one). A field may be ADDED; none may be
 * renamed, removed or given a new meaning.
 *
 * EVERY FIELD IS MEASURED. Not one of them is seeded from the manifest, the
 * coverage plan or an estimate: they are what this limiter counted while it
 * paced the run, which is the whole reason the report may quote them as fact.
 *
 * THE IDENTITY THAT MAKES THE SPLIT CHECKABLE.
 *
 *     attempts === ok2xx + retryable400 + timeout408 + throttled429 +
 *                  otherClientError + serverError + otherStatus +
 *                  transportFailures
 *
 * It holds because `attempts` is incremented immediately before the gated
 * `fetch` call and every admitted attempt then settles in exactly one of those
 * buckets — a status class when the delegate resolved, `transportFailures`
 * when it threw. An attempt still in flight is already charged to `attempts`
 * and not yet to a bucket, so a reader of `stats()` taken mid-run can be short
 * by the requests outstanding at that instant; the importer reads it after its
 * last batch, where nothing is outstanding. A report where the identity does
 * not hold is a report to distrust rather than to reconcile.
 *
 * EVERY FIELD HERE IS REQUIRED, THE STATUS SPLIT INCLUDED. This type is the
 * `usdaRequests` field contract and the importer spreads a stats value into
 * that block verbatim, so an optional counter would let a committed report be
 * written with a measurement quietly missing — which reads downstream as "this
 * run made no request of that kind" rather than as "nobody recorded it". A
 * caller with nothing to measure reports no block at all
 * (`usdaRequests.unmeasured` with its reason) instead of a stats object with
 * holes in it.
 */
export interface UsdaRequestStats {
    configuredPerHour: number;
    vendorCapPerHour: number;
    /**
     * The import's own maximum in force for this run
     * (`USDA_IMPORT_POLICY_CAP_PER_HOUR` unless a caller lowered it). Reported
     * beside `vendorCapPerHour` because the two are what make the headroom
     * checkable from the artefact alone: `vendorCapPerHour - policyCapPerHour`
     * is what was reserved for the running API, and `configuredPerHour` can be
     * read against the bound that was actually enforced rather than against
     * the vendor's, which no import is allowed to reach.
     */
    policyCapPerHour: number;
    burstCapacity: number;
    /** Physical fetches gated — `usda.service.ts`'s internal retries included. */
    attempts: number;
    /**
     * Those same physical attempts split by the status class the vendor
     * answered with. See `UsdaStatusClassCounts` for why the limiter is the
     * only place this can be counted, and the identity above for how a reader
     * checks the split against `attempts`.
     */
    statusClassCounts: UsdaStatusClassCounts;
    /**
     * Attempts whose `fetch` REJECTED instead of answering — DNS failure, a
     * dropped connection, an abort. They are the other half of the identity
     * above, and they are worth their own counter rather than a status bucket
     * because they are a different fault: a 5xx means the import reached USDA
     * and USDA failed, while one of these means it never got there, and only
     * the second one implicates the host the import is running on.
     *
     * The error itself is never captured or reshaped here — it is rethrown
     * exactly as thrown, so `usda.service.ts`'s retry ladder sees what it
     * always saw and the vendor boundary stays the vendor boundary's business.
     */
    transportFailures: number;
    pauses: number;
    totalPausedMs: number;
    longestPauseMs: number;
    firstAttemptAt: string | null;
    lastAttemptAt: string | null;
    /**
     * Which ledger actually paced the run. Worth reporting because it is the
     * difference between a ceiling that held across the whole hour and one that
     * held only within this process: a report showing `process_local` is a
     * report whose `attempts` cannot be added to another run's.
     */
    ledgerKind: UsdaRateLedgerKind;
    /** The ledger's accounting scope — never the credential itself. */
    ledgerScope: string;
    /**
     * Attempts the ledger counted inside the rolling hour at the most recent
     * reservation, or 0 before the first. Unlike `attempts` (this limiter's own
     * admissions) it includes what other processes and earlier runs spent, so
     * `attemptsInWindow > attempts` is the durable ledger working as intended.
     */
    attemptsInWindow: number;
}

export interface UsdaRateLimiter {
    /**
     * Consumes one request's allowance — one burst token AND one slot in the
     * rolling-hour ceiling — waiting for however long each of the two takes.
     * It never drops a request, and ordinary exhaustion is always a wait: a
     * full bucket or a spent hour makes it slower, never unsuccessful.
     *
     * IT CAN THROW, and only for one reason: the durable ledger behind the
     * hourly ceiling could not be trusted (`UsdaRateLedgerError` — an
     * unreadable or corrupt state file, a lock that could not be taken or held
     * exclusively, a ledger directory that could not be created). That direction is the
     * correct one. An import that stops loudly is recoverable — the checkpoint
     * survives, the operator fixes the state and resumes, and nothing was
     * spent that the report does not show — whereas pacing from state this
     * module could not read means over-spending a key the live API shares, and
     * a throttled key degrades a user-facing feature for the rest of the hour
     * with no signal anywhere in this run. So the unusable-ledger case fails
     * the import rather than the feature.
     *
     * Calls are serialised internally, in order: the reservation in the middle
     * of an acquisition is awaited, and without a queue two concurrent callers
     * could both pass the burst check before either spent its token.
     */
    acquire(): Promise<void>;
    /**
     * Gates USDA traffic by wrapping `globalThis.fetch`, and returns the
     * function that puts the original back.
     *
     * This mutates a process-wide global, so the caller MUST invoke the
     * returned restore function in a `finally` — otherwise a failed import
     * leaves the wrapper installed for the rest of the process. Calling
     * `install` twice is the same installation, and the restore is safe to
     * call more than once.
     *
     * Restoring is ownership-safe: it puts the original back only while
     * `globalThis.fetch` is still this limiter's wrapper. If something else
     * wrapped `fetch` after `install()`, that owner is left alone and this
     * limiter's wrapper stays in the chain beneath it — harmless, because it
     * paces nothing but USDA traffic, and strictly better than silently
     * disabling a wrapper this module knows nothing about. A later restore
     * still succeeds once that owner steps down.
     */
    install(): () => void;
    /** Everything this limiter measured; see `UsdaRequestStats`. */
    stats(): UsdaRequestStats;
}

export interface UsdaRateLimiterOptions {
    requestsPerHour: number;
    vendorCapPerHour?: number;
    /**
     * The import's own hourly maximum, defaulting to
     * `USDA_IMPORT_POLICY_CAP_PER_HOUR`. It exists so a caller can go LOWER —
     * a smoke run on a key that is also serving a busy environment, say — and
     * for no other reason: it is validated at or below `vendorCapPerHour`, so
     * passing a larger one is refused as the misconfiguration it is rather
     * than honoured as a widening of the ceiling.
     */
    policyCapPerHour?: number;
    burstCapacity?: number;
    /** A bare hostname or a base URL — `usda.service.ts` honours `USDA_BASE_URL`. */
    host?: string;
    now?: () => number;
    sleep?: (ms: number) => Promise<void>;
    logger?: ScriptLogger;
    /**
     * The rolling-hour ledger. Omit it and the limiter is DURABLE BY DEFAULT:
     * it builds a `createFileUsdaRateLedger` at `ledgerStateFilePath` (or the
     * derived default path) so a caller that passes nothing but a rate still
     * gets a ceiling that survives a restart. Pass
     * `createProcessLocalUsdaRateLedger()` to opt out — for a single-shot tool
     * or a test — and pass a ledger of your own to reach shared state this
     * module cannot see.
     */
    ledger?: UsdaRateLedger;
    /**
     * The accounting scope of the default file ledger, defaulting to the paced
     * host. It names the shared CREDENTIAL's hour, not this run, so every
     * importer spending the same key must use the same scope. It is reported
     * and logged, so it must not be, or be derived from, the key itself.
     */
    ledgerScope?: string;
    /** Where the default file ledger keeps its state; see `defaultUsdaRateLedgerStateFilePath`. */
    ledgerStateFilePath?: string;
}

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
 * one. Bounds are the caller's business; this decides only whether a number was
 * written at all, and whether the one written is the one that would be enforced.
 *
 * `Number()` implements the JavaScript numeric-literal grammar, not a decimal
 * reader, so on its own it accepts forms no operator means by a count: `0x10`
 * becomes 16, `1e3` becomes 1000, `+7` becomes 7, `8.` becomes 8, and because
 * `String.prototype.trim` removes U+00A0 a non-breaking space pasted before a
 * digit disappears silently. Each of those would be enforced as a rate nobody
 * asked for — `1e3` in particular lands on the vendor's full 1,000/hour, wiping
 * out the headroom this module exists to protect. `Number()` also rounds:
 * `Number('9007199254740993')` is 9007199254740992, which passes
 * `Number.isInteger` and every range check while no longer being the value that
 * was typed. So the digits are checked before the number is believed, and a
 * magnitude that cannot be represented exactly is refused rather than rounded.
 *
 * `budget.ts` reads `CATALOG_MODEL_CALL_BUDGET` and `CATALOG_BATCH_SIZE` under
 * this same rule. The rule is stated once per module rather than shared from a
 * third file because each module maps the outcome onto its own error class, and
 * neither may import the other: this one touches no database, and that one
 * never calls a vendor.
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
        // report — it is the rate the run would otherwise have enforced —
        // whereas the raw string is never echoed: a misplaced paste can put a
        // credential on a line that reaches terminals, CI logs and committed
        // reports.
        return { kind: 'not_decimal', reads: Number(trimmed) };
    }

    const value = Number(trimmed);
    if (!Number.isSafeInteger(value)) {
        // Digits only by now, so the only way here is a magnitude past
        // 2^53-1, where the nearest representable double is a different
        // number. The digit count says how far out of range it is without
        // echoing either the raw text or the misleading rounded value.
        return { kind: 'not_exact', digits: trimmed.replace(/^0+(?=[0-9])/, '').length };
    }

    return { kind: 'ok', value };
};

/**
 * Resolves the importer's hourly rate — the only place
 * `USDA_IMPORT_RATE_LIMIT_PER_HOUR` is read.
 *
 * Absent or blank means the default. A value that is present but unusable
 * throws instead of falling back, which is where this deliberately parts
 * company with `entitlement.service.ts`'s `getDailyQuota()`: a quota that
 * quietly reverts to its default only affects the caller, whereas a rate that
 * quietly reverts hides a typo that either wastes hours of import time or
 * throttles the key the live API shares.
 *
 * The upper bound it enforces is `USDA_IMPORT_POLICY_CAP_PER_HOUR`, NOT the
 * vendor cap. Bounding this read at 1,000 was the same mistake as having no
 * bound at all for the thing the number protects: 901 through 1,000 are all
 * inside what USDA permits the key and all eat into the 100 per hour the
 * running API needs on it, so they are refused here — at startup, in one place,
 * before a single request is paced — rather than quietly honoured.
 */
export const getUsdaImportRateLimitPerHour = (env: NodeJS.ProcessEnv = process.env): number => {
    const raw = env[RATE_LIMIT_ENV_VAR];
    if (raw === undefined || raw.trim().length === 0) {
        return DEFAULT_USDA_IMPORT_RATE_LIMIT_PER_HOUR;
    }

    const read = readDecimalInteger(raw);

    if (read.kind === 'not_decimal') {
        // The number `Number()` would have produced is safe to echo; the raw
        // string is not, for the reason given on `readDecimalInteger`.
        const observed = Number.isFinite(read.reads) ? `${read.reads}` : 'not a number';
        throw new RateLimitConfigError(
            `${RATE_LIMIT_ENV_VAR} must be decimal digits only, with no sign, decimal point, exponent or hex prefix (got ${observed})`,
            Number.isFinite(read.reads) ? read.reads : null,
            null,
            USDA_VENDOR_CAP_PER_HOUR,
        );
    }

    if (read.kind === 'not_exact') {
        // No `requestsPerHour` travels on this one: every candidate value is
        // either the raw text or the rounded number, and reporting the rounded
        // number is the specific dishonesty this rejection exists to prevent.
        throw new RateLimitConfigError(
            `${RATE_LIMIT_ENV_VAR} is too large to be read exactly: ${read.digits} digits exceeds the largest safe integer ${Number.MAX_SAFE_INTEGER}`,
            null,
            null,
            USDA_VENDOR_CAP_PER_HOUR,
        );
    }

    if (read.value <= 0 || read.value > USDA_IMPORT_POLICY_CAP_PER_HOUR) {
        // The bound this value broke is the IMPORT ceiling, so that is the
        // number travelling as the error's cap — reporting 1,000 would name a
        // limit a configured 950 does not break and leave the operator
        // looking for a different problem. Both numbers are in the message
        // because the remedy depends on the difference between them: the
        // refusal is not "USDA would throttle you", it is "the running API
        // needs the rest of that key".
        throw new RateLimitConfigError(
            `${RATE_LIMIT_ENV_VAR} must be an integer between 1 and ${USDA_IMPORT_POLICY_CAP_PER_HOUR} ` +
                `(got ${read.value}): the import must not exceed the import ceiling of ` +
                `${USDA_IMPORT_POLICY_CAP_PER_HOUR} requests/hour; USDA's per-key cap is ` +
                `${USDA_VENDOR_CAP_PER_HOUR} and the remaining ` +
                `${USDA_VENDOR_CAP_PER_HOUR - USDA_IMPORT_POLICY_CAP_PER_HOUR}/hour are reserved for the ` +
                `running API's estimate, label-scan and branded-search traffic on the same key`,
            read.value,
            null,
            USDA_IMPORT_POLICY_CAP_PER_HOUR,
        );
    }

    return read.value;
};

/**
 * Advances a bucket to `nowMs`, clamped at `capacity`.
 *
 * Monotonic-safe on purpose: `Date.now()` can step backwards (NTP correction,
 * a VM resuming), and a bucket that lost tokens to a clock adjustment would
 * stall an import for no reason. A reading at or before `lastRefillMs` adds
 * nothing, removes nothing, and never rewinds `lastRefillMs` — otherwise the
 * next legitimate reading would measure its elapsed time from the wrong
 * origin and hand out tokens the vendor never granted.
 */
export const refillBucket = (
    state: BucketState,
    nowMs: number,
    tokensPerMs: number,
    capacity: number,
): BucketState => {
    const elapsedMs = Number.isFinite(nowMs) ? nowMs - state.lastRefillMs : 0;

    if (!(elapsedMs > 0)) {
        return { tokens: Math.min(state.tokens, capacity), lastRefillMs: state.lastRefillMs };
    }

    return {
        tokens: Math.min(state.tokens + elapsedMs * tokensPerMs, capacity),
        lastRefillMs: nowMs,
    };
};

/**
 * How long to wait, from `nowMs`, before one whole token is available.
 *
 * Zero when the bucket already has one. A non-positive or non-finite rate
 * returns `Infinity` rather than zero: at that rate a token never arrives, and
 * answering "go ahead" would be a lie that lets an unpaced request out.
 * `createUsdaRateLimiter` rejects such rates, so `acquire` never sees it.
 */
export const waitMsForToken = (
    state: BucketState,
    nowMs: number,
    tokensPerMs: number,
    capacity: number,
): number => {
    const refilled = refillBucket(state, nowMs, tokensPerMs, capacity);

    if (refilled.tokens >= 1) {
        return 0;
    }
    if (!(tokensPerMs > 0)) {
        return Number.POSITIVE_INFINITY;
    }

    return Math.ceil((1 - refilled.tokens) / tokensPerMs);
};

/**
 * Drops the attempt stamps that have aged out of the window ending at `nowMs`.
 *
 * The far boundary is INCLUSIVE — a stamp exactly at `nowMs - windowMs` still
 * counts — which costs one millisecond of allowance and buys an unconditional
 * guarantee. Read the hour as `(nowMs - windowMs, nowMs]` and an exclusive
 * boundary is correct, but read it as the closed `[nowMs - windowMs, nowMs]`
 * and an exclusive boundary admits `limit + 1`: the stamp that just aged out
 * plus a full window. USDA does not publish which way it counts, and the whole
 * point of this ledger is a ceiling that holds either way, so the boundary
 * instant is charged rather than forgiven. `windowWaitMs` floors the resulting
 * zero wait at 1ms, which is exactly how long that slot is withheld.
 *
 * A stamp that is not a finite number is dropped outright — it could never age
 * out and would freeze the ledger for the rest of the run.
 */
export const pruneAttemptWindow = (
    stamps: readonly number[],
    nowMs: number,
    windowMs: number,
): number[] => {
    const cutoffMs = nowMs - windowMs;

    if (!Number.isFinite(cutoffMs)) {
        // A reading that cannot produce a cutoff says nothing about what has
        // aged out, and pruning on it would hand back an hour of allowance the
        // vendor never granted. Keep every usable stamp instead.
        return stamps.filter((stamp) => Number.isFinite(stamp));
    }

    return stamps.filter((stamp) => Number.isFinite(stamp) && stamp >= cutoffMs);
};

/**
 * How long to wait, from `nowMs`, before the rolling window has room for one
 * more attempt. Zero while it holds fewer than `limit`.
 *
 * The wait is measured from the OLDEST stamp still inside the window, which is
 * the head: `recordAttemptWindow` keeps the sequence monotonically
 * nondecreasing. Reading the head rather than scanning for the minimum is also
 * the safe direction if a caller hands over an unordered array — the head is
 * then never older than the true minimum, so the wait can only come out longer
 * than needed, never shorter.
 */
export const windowWaitMs = (
    stamps: readonly number[],
    nowMs: number,
    limit: number,
    windowMs: number,
): number => {
    const inWindow = pruneAttemptWindow(stamps, nowMs, windowMs);

    if (inWindow.length < limit) {
        return 0;
    }

    const oldestMs = inWindow[0];
    if (oldestMs === undefined) {
        return 0;
    }

    // The floor is load-bearing in two cases. A stamp sitting exactly on the
    // inclusive far boundary computes a zero wait, and that slot is withheld
    // for the one millisecond it takes to leave the closed window. An unusable
    // clock (a non-finite reading prunes nothing and can compute a non-finite
    // difference) would otherwise either let `acquire` spin or park the import
    // forever on an infinite wait.
    const waitMs = Math.ceil(oldestMs + windowMs - nowMs);
    return Number.isFinite(waitMs) && waitMs > 0 ? waitMs : 1;
};

/**
 * Records one admitted attempt and drops whatever aged out with it.
 *
 * The appended stamp is clamped to `Math.max(nowMs, lastStamp)`, mirroring
 * `refillBucket`'s monotonic-safety posture: `Date.now()` can step backwards
 * (NTP correction, a VM resuming), and a stamp written behind the previous one
 * would age out early and grant allowance the vendor did not. The clamp keeps
 * the sequence nondecreasing, which is what makes the head the oldest entry.
 *
 * A non-finite reading is stamped at the most recent known one rather than
 * dropped — an admitted attempt that leaves no trace is exactly the allowance
 * leak this ledger exists to close.
 */
export const recordAttemptWindow = (
    stamps: readonly number[],
    nowMs: number,
    windowMs: number,
): number[] => {
    const lastMs = stamps.length > 0 ? stamps[stamps.length - 1] : undefined;
    const previousMs = lastMs !== undefined && Number.isFinite(lastMs) ? lastMs : 0;
    const stampedMs = Number.isFinite(nowMs) ? Math.max(nowMs, previousMs) : previousMs;

    // Pruned against the clamped stamp, not the raw reading: the monotonic
    // maximum is the ledger's notion of now, so the two operations cannot
    // disagree about which entries are still inside the hour.
    return pruneAttemptWindow([...stamps, stampedMs], stampedMs, windowMs);
};

/**
 * Reduces a hostname to the one form host comparisons are made in: lower case,
 * with the DNS root's trailing dot removed.
 *
 * `api.nal.usda.gov.` is the fully qualified spelling of `api.nal.usda.gov` —
 * it resolves to the same addresses and reaches the same vendor — but WHATWG
 * `URL` keeps the dot in `hostname`, and `hostOf` only lower-cases. Comparing
 * the raw hostname therefore reads the FQDN form as a different host, and an
 * unrecognised host is not paced: the request would go to USDA spending none of
 * this limiter's allowance, against a key whose 1,000/hour the running API
 * shares. Exactly one dot is stripped, because `api.nal.usda.gov..` is not a
 * resolvable name and must keep failing the match rather than be repaired into
 * one.
 *
 * This is the same rule `dbGuard.ts` applies to `DATABASE_URL`
 * (`hostname.toLowerCase().replace(/\.$/, '')`), and the two must agree: a host
 * that one module treats as USDA and the other as unrecognised is the gap this
 * closes.
 */
const canonicalHostname = (hostname: string): string => hostname.toLowerCase().replace(/\.$/, '');

// `hostOf` reduces a URL to its hostname but answers 'invalid-url' for a bare
// hostname, so which form arrived has to be decided first. Both are accepted
// because `usda.service.ts` reads `USDA_BASE_URL`, and a caller wiring the
// limiter to a mock server would naturally pass that base URL straight through.
// Both branches canonicalise, so a configured host, a configured base URL and
// an outgoing request URL are all compared in the same form.
const normalizeHost = (host: string): string => {
    const trimmed = host.trim();
    if (!trimmed.includes('://')) {
        return canonicalHostname(trimmed);
    }
    const parsed = hostOf(trimmed);
    return parsed === 'invalid-url' ? '' : canonicalHostname(parsed);
};

// `fetch` accepts a string, a URL or a Request. The `url`/`href` duck-typing
// covers a Request without naming its type and a URL that crossed a realm
// boundary, where `instanceof` would quietly fail and leave requests unpaced.
const hrefOf = (input: unknown): string | null => {
    if (typeof input === 'string') {
        return input;
    }
    if (input instanceof URL) {
        return input.href;
    }
    if (typeof input === 'object' && input !== null) {
        const candidate = input as { url?: unknown; href?: unknown };
        if (typeof candidate.url === 'string') {
            return candidate.url;
        }
        if (typeof candidate.href === 'string') {
            return candidate.href;
        }
    }
    return null;
};

/**
 * Whether a `fetch` argument addresses the paced host. Anything that does not
 * parse is not a USDA request and passes through unpaced — a malformed URL is
 * the caller's problem to hear about from `fetch`, not this module's to spend
 * allowance on.
 */
export const isUsdaRequestUrl = (input: unknown, host: string = USDA_HOST): boolean => {
    const href = hrefOf(input);
    const expected = normalizeHost(host);

    if (href === null || expected.length === 0) {
        return false;
    }

    try {
        return canonicalHostname(new URL(href).hostname) === expected;
    } catch {
        return false;
    }
};

/**
 * Which bucket of `UsdaStatusClassCounts` one answered attempt belongs to.
 *
 * Exported and pure for the same reason the window rules are: the boundaries
 * are the part someone could get wrong — 400, 408 and 429 are counted EXACTLY
 * and everything else in 4xx is `otherClientError`, so a `<= 429` or a `>= 400`
 * written the wrong way round would silently move a throttling report into a
 * bad-key report — and a test pins them with no clock, no network and no
 * `Response`.
 *
 * The input is `unknown` on purpose. The declared type of `Response.status` is
 * `number`, but this runs against whatever the installed `fetch` resolved: a
 * stub transport, an instrumentation wrapper, or a runtime resolving something
 * that is not a `Response` at all. An attempt has already been charged to the
 * hour by the time this is asked, so an unreadable status has to land
 * SOMEWHERE (`otherStatus`) rather than be dropped — the `attempts` identity on
 * `UsdaRequestStats` is what the report's split is checked against, and a
 * dropped attempt is exactly what would break it.
 */
export const usdaStatusClass = (status: unknown): keyof UsdaStatusClassCounts => {
    if (typeof status !== 'number' || !Number.isFinite(status)) {
        return 'otherStatus';
    }
    // The three transient statuses first, and by equality: each is one status
    // the retry ladder treats differently from its neighbours, and each is the
    // answer to a question about the run that a 4xx range cannot answer.
    if (status === 400) {
        return 'retryable400';
    }
    if (status === 408) {
        return 'timeout408';
    }
    if (status === 429) {
        return 'throttled429';
    }
    if (status >= 200 && status < 300) {
        return 'ok2xx';
    }
    if (status >= 400 && status < 500) {
        return 'otherClientError';
    }
    if (status >= 500) {
        return 'serverError';
    }
    return 'otherStatus';
};

// Every class starts at zero rather than absent, because a class with no
// attempts really did have none: these counters only ever grow from attempts
// this limiter admitted, so a zero here is a measurement and not a gap.
const emptyStatusClassCounts = (): UsdaStatusClassCounts => ({
    ok2xx: 0,
    retryable400: 0,
    timeout408: 0,
    throttled429: 0,
    otherClientError: 0,
    serverError: 0,
    otherStatus: 0,
});

// Deliberately not `unref()`'d: a pause has to keep the process alive, or a
// run that pauses near the end would exit mid-import and look like a clean
// finish.
const defaultSleep = (ms: number): Promise<void> =>
    new Promise<void>((resolve) => {
        setTimeout(resolve, ms);
    });

// A stats field must never be able to end a multi-hour import, and
// `toISOString()` throws on a timestamp outside the Date range.
const isoOf = (epochMs: number): string | null => {
    if (!Number.isFinite(epochMs)) {
        return null;
    }
    try {
        return new Date(epochMs).toISOString();
    } catch {
        return null;
    }
};

// ---------------------------------------------------------------------------
// The rolling-hour ledgers.
//
// Both implementations of the port are thin: every decision they make comes
// from `pruneAttemptWindow`, `windowWaitMs` and `recordAttemptWindow` above, so
// the inclusive far boundary, the monotonic clamping and the non-finite
// handling are defined once and are already pinned by their own unit tests. The
// difference between the two is entirely WHERE the stamps live and who else can
// see them.
// ---------------------------------------------------------------------------

/**
 * The state document's shape version. Bumped only when the document's meaning
 * changes; a ledger refuses a version it does not know rather than guessing at
 * a newer build's fields.
 */
export const USDA_RATE_LEDGER_STATE_VERSION = 1;

/** The default accounting scope: the paced host, which is what the key is used against. */
export const DEFAULT_USDA_RATE_LEDGER_SCOPE = USDA_HOST;

/**
 * How old a lock file has to be before it is assumed abandoned.
 *
 * The critical section it guards is one read, one prune and one rename —
 * sub-millisecond — so 30 seconds is four orders of magnitude of slack. It is
 * deliberately that far out: breaking a lock a live process still holds
 * reintroduces the double-admit this lock exists to prevent, while waiting 30
 * seconds after a `kill -9` costs an import nothing it will not make back.
 */
export const DEFAULT_LEDGER_LOCK_STALE_MS = 30_000;

/**
 * The bounded retry loop for a contended lock. The product of the two
 * (160 × 250ms = 40s) is deliberately LONGER than
 * `DEFAULT_LEDGER_LOCK_STALE_MS`: a lock abandoned by a crashed process has to
 * become breakable before the retries run out, or a crash would turn into a
 * permanent refusal instead of a 30-second pause.
 */
export const DEFAULT_LEDGER_LOCK_ATTEMPTS = 160;
export const DEFAULT_LEDGER_LOCK_RETRY_DELAY_MS = 250;

const LEDGER_FILE_PREFIX = 'usda-rate-ledger.';
const LEDGER_FILE_SUFFIX = '.json';

// One fixed, unmistakable name under the host's temp root. Fixed because every
// importer on the host has to derive the SAME directory from nothing but this
// module — a name carrying a version, a user or a checkout would split the
// accounting the directory exists to pool.
const LEDGER_HOST_DIRECTORY_NAME = 'soh-usda-rate-ledger';

/**
 * The mode the ledger directory is created with, and the mode its state and
 * lock files are written with. Owner-only in both cases: the directory sits in
 * a world-writable temp root, and a ledger another user could rewrite is a
 * ledger that can be made to say the hour is empty.
 */
const LEDGER_DIRECTORY_MODE = 0o700;
const LEDGER_FILE_MODE = 0o600;

// Long enough for a hostname, short enough that prefix + scope + suffix clears
// every filesystem's name limit with room to spare.
const LEDGER_SCOPE_FILE_NAME_LIMIT = 80;

/**
 * What a lock file's content says about who holds it now, compared against the
 * token it is expected to still hold.
 *
 * `held` — the same lock, unchanged. `released` — the lock file is gone.
 * `reacquired` — a lock file is there, stamped by somebody else.
 */
export type LedgerLockOwnership = 'held' | 'released' | 'reacquired';

/**
 * The lock-ownership verdict, as a pure comparison so both places that need it
 * reach the same conclusion and both can be unit tested without a filesystem.
 *
 * `observed` is the lock file's content, or `null` when the file does not
 * exist. `expected` is the token it must still carry — our own token when the
 * question is "is the critical section still ours?", and the token read a
 * moment earlier when the question is "is this the same abandoned lock I
 * measured the age of?".
 *
 * Both sides are trimmed because the token is written with a trailing newline,
 * so a lock file read back is compared on its content and not on its
 * line ending. Two blank observations compare EQUAL on purpose: a lock file
 * carrying no token at all — written by an older build, or by a process that
 * died between creating the file and stamping it — is still an abandoned lock
 * that must stay breakable once it goes stale. It can never read as `held`
 * against a real token, because a minted token is never blank.
 */
export const ledgerLockOwnership = (observed: string | null, expected: string): LedgerLockOwnership => {
    if (observed === null) {
        return 'released';
    }

    return observed.trim() === expected.trim() ? 'held' : 'reacquired';
};

/**
 * Reduces a caller's scope to the one form it is compared and reported in.
 *
 * @throws RateLimitConfigError when the scope is blank. A ledger with no scope
 * would silently share one accounting file with every other scope-less caller
 * on the host, which is a configuration mistake worth hearing about at startup
 * rather than a default worth inventing.
 */
const normalizeLedgerScope = (scope: string): string => {
    const trimmed = scope.trim().toLowerCase();

    if (trimmed.length === 0) {
        throw new RateLimitConfigError(
            'ledger scope must not be blank: the scope names the shared credential whose hourly ' +
                'spend is being tracked, and a blank one would pool unrelated keys into one ledger',
        );
    }

    return trimmed;
};

/**
 * The state file name for a scope.
 *
 * Every character outside `[a-z0-9._-]` becomes `_`, which is what keeps a
 * scope from steering the path: a scope containing `/` or `..` cannot escape
 * the ledger directory because no separator survives. Two scopes CAN collide
 * after sanitising or truncation, and that is the acceptable direction — a
 * collision makes two keys share one hourly ledger, which over-restricts both
 * (each sees the other's spend and paces harder) rather than over-admitting
 * either. An operator who needs the two accounted separately passes explicit,
 * distinct `stateFilePath`s.
 */
const ledgerFileNameFor = (scope: string): string => {
    const sanitized = scope.replace(/[^a-z0-9._-]+/g, '_').slice(0, LEDGER_SCOPE_FILE_NAME_LIMIT);

    return `${LEDGER_FILE_PREFIX}${sanitized}${LEDGER_FILE_SUFFIX}`;
};

/**
 * Where the default file ledger lives: one `soh-usda-rate-ledger/` directory
 * directly beneath `os.tmpdir()`, shared by every importer on the host and
 * derived from nothing else — not this module's location, not the working
 * directory, not any environment variable.
 *
 * THE ACCOUNTING HAS TO BE SHARED BY EVERY PROCESS THAT SHARES THE CREDENTIAL.
 * USDA's 1,000/hour belongs to the KEY, and every importer on a machine reads
 * the same `USDA_API_KEY` out of the same environment, so the hour they are
 * spending is one hour. Host-wide is therefore the narrowest scope that is
 * still correct. A per-CHECKOUT path was the defect this default replaces: two
 * clones on one build host each kept their own ledger and each handed itself
 * the full 900, which is exactly the "two concurrent importers" over-spend the
 * ledger exists to prevent, and a path under `node_modules` additionally lost
 * the hour's record to every `npm ci`, redeploy or dependency refresh — the
 * restart boundary the durable ledger is for.
 *
 * Two caveats a reader needs, both deliberate.
 *
 * A tmp reaper (or a reboot) can remove the file between runs. That is
 * benign: the document is rewritten whole on every reservation, and an absent
 * file is exactly the first-run case that already reads as "nothing spent".
 * What it costs is the record of an hour nobody was importing through —
 * reapers age files out over days and a reboot ends every importer on the
 * host — so the two cases this ledger exists for, a restart inside the hour
 * and a second concurrent importer, both still read the same file.
 *
 * The directory is created 0700 and the state and lock files 0600, so every
 * importer sharing one ledger must run as the same OS user. A second user's
 * importer does not get a silent second allowance — it cannot open the lock or
 * read the state, so it fails closed with `lock_unavailable` or
 * `state_unreadable` and stops. Running the pipeline under one service account
 * is the configuration; a second account is a configuration error that says so.
 *
 * One thing to know about the root itself: `os.tmpdir()` reads `TMPDIR` (and
 * `TMP`/`TEMP`), so giving the pipeline's processes different values for those
 * splits the accounting exactly the way the per-checkout path did. The
 * processes that share a key must share a temp root, which is the default on
 * every host this runs on and is not something to override per process.
 *
 * The deliberate override, for the case this default gets wrong, is
 * `FileUsdaRateLedgerOptions.scope` / `stateFilePath` (and
 * `UsdaRateLimiterOptions.ledgerScope` / `ledgerStateFilePath`): genuinely
 * separate keys are genuinely separate allowances and want distinct scopes, or
 * distinct paths where two operators cannot agree on a scope string.
 *
 * WHAT IS STILL NOT COVERED is cross-HOST: two importers on two machines
 * sharing one key cannot see each other's file, and no filesystem-backed
 * ledger can close that. Closing it means giving `reserve` state both hosts
 * can read, which is precisely what the `ledger` port is for — a
 * `createDatabaseUsdaRateLedger` honouring the same single `reserve` contract
 * is injected through `UsdaRateLimiterOptions.ledger` and nothing else here
 * changes — and the shared rolling-window table it would read is not in the
 * Prisma schema, so it stays a schema proposal rather than a default this
 * module can ship. While the ledger is file-backed, the accounting holds only
 * as far as the filesystem reaches, and the operating instruction that keeps
 * the key's hour intact is one importer host per rolling hour.
 */
export const defaultUsdaRateLedgerDirectory = (): string =>
    path.join(os.tmpdir(), LEDGER_HOST_DIRECTORY_NAME);

/** The default state file path for a scope, inside `defaultUsdaRateLedgerDirectory()`. */
export const defaultUsdaRateLedgerStateFilePath = (
    scope: string = DEFAULT_USDA_RATE_LEDGER_SCOPE,
): string => path.join(defaultUsdaRateLedgerDirectory(), ledgerFileNameFor(normalizeLedgerScope(scope)));

/**
 * The in-memory ledger: today's closure-local array, and NOT DURABLE by
 * design.
 *
 * It holds the hourly ceiling within one construction of one process and
 * nothing further — a restart, a second importer, or even a second limiter in
 * this process each start from an empty hour. Two uses are legitimate. A test
 * that drives pacing with an injected clock wants exactly this and no
 * filesystem. And a single-shot tool that makes a handful of USDA calls and
 * exits inside a run an operator is watching is not the thing that exhausts a
 * 1,000/hour key.
 *
 * It is NOT for the catalog importer: that is a multi-hour run which is
 * expected to be interrupted and resumed, which is what
 * `createFileUsdaRateLedger` exists for and why the limiter defaults to it.
 */
export const createProcessLocalUsdaRateLedger = (
    options: { scope?: string } = {},
): UsdaRateLedger => {
    const scope = normalizeLedgerScope(options.scope ?? DEFAULT_USDA_RATE_LEDGER_SCOPE);

    let attempts: number[] = [];

    // `async` for the port's sake, not for any awaiting: one process's array is
    // already mutually excluded, because nothing else can observe it and
    // JavaScript runs this body to completion without interleaving.
    const reserve = async (input: UsdaRateLedgerReserveInput): Promise<UsdaRateReservation> => {
        attempts = pruneAttemptWindow(attempts, input.nowMs, input.windowMs);

        const waitMs = windowWaitMs(attempts, input.nowMs, input.limit, input.windowMs);
        if (waitMs > 0) {
            return { admitted: false, waitMs, attemptsInWindow: attempts.length };
        }

        attempts = recordAttemptWindow(attempts, input.nowMs, input.windowMs);

        return { admitted: true, waitMs: 0, attemptsInWindow: attempts.length };
    };

    return {
        reserve,
        describe: (): UsdaRateLedgerDescription => ({ kind: 'process_local', scope }),
    };
};

export interface FileUsdaRateLedgerOptions {
    /**
     * The accounting scope — the shared credential's hour, not this run's.
     * Defaults to the paced host.
     *
     * Two imports running under DIFFERENT USDA keys are two independent 1,000/hour
     * allowances and must be given distinct scopes, or each will be paced by the
     * other's spend. Two imports under the SAME key must share one scope. This
     * module cannot tell which case it is in, because it reads no environment
     * variable and never sees a key; sharing is the default precisely because it
     * is the over-restrictive direction — a shared ledger paces harder than
     * necessary, while a split one admits more than the vendor allows.
     */
    scope?: string;
    /** Defaults to `defaultUsdaRateLedgerStateFilePath(scope)`. */
    stateFilePath?: string;
    lockStaleMs?: number;
    lockAttempts?: number;
    lockRetryDelayMs?: number;
    /** Injected so a test does not really wait out lock contention. */
    sleep?: (ms: number) => Promise<void>;
}

/** The on-disk document. Small, versioned, and rewritten whole on every change. */
interface UsdaRateLedgerStateDocument {
    version: number;
    scope: string;
    attempts: number[];
}

// Node's fs errors carry a `code`; reading it without asserting a type keeps
// this honest about the fact that a thrown value is `unknown`.
const errorCodeOf = (error: unknown): string | null => {
    if (typeof error === 'object' && error !== null) {
        const code = (error as { code?: unknown }).code;
        if (typeof code === 'string') {
            return code;
        }
    }

    return null;
};

/**
 * The durable, cross-process ledger: a JSON document under a sibling lock file.
 *
 * WHAT MAKES IT CORRECT, in two parts.
 *
 * Mutual exclusion: `fs.openSync(lock, 'wx')` is the only atomic
 * test-and-create available without a dependency, and it is atomic on every
 * filesystem this pipeline runs on (it maps to `O_CREAT | O_EXCL`). The lock is
 * held across the read, the decision and the write — a load here and a save
 * later would let two importers both read 899 and both admit, which is the
 * exact defect this ledger closes — and released immediately after, so it is
 * never a lease and needs no timer to keep it alive (AAP §0.8.2). Each
 * acquisition stamps the lock file with a token identifying itself, and that
 * token is what every later decision about the lock is made on: a lock is
 * broken only while its token is unchanged, released only while the token is
 * still ours, and an admission is reported only after the token is
 * re-confirmed and the written document read back (read `breakStaleLock` for
 * the race this closes). A lock whose mtime is older than `lockStaleMs` is
 * assumed abandoned by a crashed process and removed; contention otherwise
 * retries a bounded number of times and then refuses.
 *
 * Durability: the document is written to a temp file in the SAME directory and
 * `renameSync`d over the state file, which is atomic within a filesystem. A
 * crash therefore leaves either the previous document or the new one, never a
 * truncated document that would read as fewer attempts than were spent. The
 * array is pruned on every write, so the file stays bounded by `limit` entries
 * however long the run lasts.
 *
 * The write happens BEFORE the caller is told it may proceed, so a process
 * killed between the two has charged an attempt it never made. That is the
 * deliberate direction: over-charging costs the import a slot it can wait for,
 * under-charging spends a key the live API depends on.
 *
 * Lock ages are measured with `Date.now()` against the filesystem's mtime, not
 * with the limiter's injected clock: the two coordinates have to be comparable,
 * and a test driving an hour of pacing in a millisecond of wall time must not
 * thereby declare every fresh lock abandoned.
 *
 * Nothing touches the filesystem until the first `reserve`.
 */
export const createFileUsdaRateLedger = (options: FileUsdaRateLedgerOptions = {}): UsdaRateLedger => {
    const scope = normalizeLedgerScope(options.scope ?? DEFAULT_USDA_RATE_LEDGER_SCOPE);
    const stateFilePath = options.stateFilePath ?? defaultUsdaRateLedgerStateFilePath(scope);
    const lockFilePath = `${stateFilePath}.lock`;
    const stateDirectory = path.dirname(stateFilePath);
    const lockStaleMs = options.lockStaleMs ?? DEFAULT_LEDGER_LOCK_STALE_MS;
    const lockAttempts = options.lockAttempts ?? DEFAULT_LEDGER_LOCK_ATTEMPTS;
    const lockRetryDelayMs = options.lockRetryDelayMs ?? DEFAULT_LEDGER_LOCK_RETRY_DELAY_MS;
    const sleep = options.sleep ?? defaultSleep;

    // Checked at construction, like every other rate configuration in this
    // module (§9): a non-finite staleness threshold would make every lock look
    // fresh forever, and a non-positive attempt count would refuse every
    // reservation the moment a lock was contended. Both are operator errors
    // that must surface before an import starts, not hours into one. Zero is
    // allowed for the two millisecond values — a test that stubs `sleep`
    // legitimately wants no delay, and a zero threshold is merely eager, not
    // unsafe.
    const requireLedgerOption = (label: string, value: number, minimum: number, integral: boolean): void => {
        const usable = Number.isFinite(value) && value >= minimum && (!integral || Number.isInteger(value));

        if (!usable) {
            throw new RateLimitConfigError(
                `${label} must be ${integral ? 'an integer' : 'a number'} of at least ${minimum} ` +
                    `(got ${Number.isFinite(value) ? `${value}` : 'not a number'})`,
            );
        }
    };

    requireLedgerOption('lockStaleMs', lockStaleMs, 0, false);
    requireLedgerOption('lockAttempts', lockAttempts, 1, true);
    requireLedgerOption('lockRetryDelayMs', lockRetryDelayMs, 0, false);

    const fail = (code: UsdaRateLedgerErrorCode, detail: string): never => {
        // Every message ends with the same sentence about the remedy, because
        // the remedy is always the same and always has the same cost: the file
        // IS the record of this hour's spend, and starting a fresh one hands
        // the run an allowance the vendor has not granted.
        throw new UsdaRateLedgerError(
            code,
            `${detail} (USDA rate ledger ${stateFilePath}, scope ${scope}). The import is stopped rather ` +
                `than paced from state that cannot be trusted. Deleting this file forfeits the record of ` +
                `what the current hour already spent, so the next run starts from a full allowance and can ` +
                `push the shared API key past its ${USDA_VENDOR_CAP_PER_HOUR}/hour limit — only delete it ` +
                `once no importer has run for an hour.`,
            stateFilePath,
            scope,
        );
    };

    let directoryReady = false;

    const ensureDirectory = (): void => {
        if (directoryReady) {
            return;
        }

        try {
            // Owner-only, because the default directory sits in a
            // world-writable temp root (`defaultUsdaRateLedgerDirectory`). An
            // existing directory keeps whatever mode it already has —
            // `mkdirSync` does not re-apply one, and this module will not
            // widen or narrow a directory an operator or another user created;
            // the files inside it are written owner-only regardless, and a
            // directory this process cannot use fails closed below.
            fs.mkdirSync(stateDirectory, { recursive: true, mode: LEDGER_DIRECTORY_MODE });
        } catch (error) {
            fail(
                'state_directory_unusable',
                `the ledger directory could not be created (${errorCodeOf(error) ?? 'unknown error'})`,
            );
        }

        directoryReady = true;
    };

    // `force` absorbs the only expected failure — the file not being there —
    // so what is left is a filesystem that will not delete a file this process
    // just created. Nothing useful can be done about it here: a leftover
    // `.tmp` is inert (it is never read, and `renameSync` replaces the state
    // file atomically), and a lock left behind is recovered by `breakStaleLock`
    // within `lockStaleMs`. Masking the caller's real error with this one would
    // lose the failure that matters.
    const discard = (target: string): void => {
        try {
            fs.rmSync(target, { force: true });
        } catch {
            return;
        }
    };

    // Same reasoning as `discard`: a descriptor that will not close says
    // nothing a caller can act on, and the stale-lock path recovers the file.
    // The reservation's own outcome is what must reach the caller.
    const closeLockDescriptor = (fd: number): void => {
        try {
            fs.closeSync(fd);
        } catch {
            return;
        }
    };

    /**
     * Reads the lock file's token, or `null` when there is no lock file.
     *
     * A lock that exists and cannot be read is a refusal, not an assumption:
     * treating an unreadable lock as absent is how a second OS user (the
     * 0700/0600 modes of the default directory) would talk itself into a
     * second allowance.
     */
    const readLockToken = (): string | null => {
        try {
            return fs.readFileSync(lockFilePath, 'utf8');
        } catch (error) {
            if (errorCodeOf(error) === 'ENOENT') {
                return null;
            }

            return fail(
                'lock_unavailable',
                `the ledger lock exists but could not be read (${errorCodeOf(error) ?? 'unknown error'})`,
            );
        }
    };

    /**
     * Mints the token that identifies ONE acquisition of the lock.
     *
     * The pid alone already distinguishes live holders — an operating system
     * does not hand the same pid to two running processes — so the creation
     * time and the random tail are there to distinguish successive
     * acquisitions by the same process, which is the case
     * `ledgerLockOwnership` is asked about most often. `Math.random` and not
     * `crypto`: the token is an identity tag for a local file, never a secret
     * and never a capability, so unpredictability buys nothing here and the
     * module's "no builtin beyond fs/path/os" posture is worth more.
     */
    const mintLockToken = (): string =>
        `usda-rate-ledger.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 12)}`;

    /**
     * Removes the lock if it is abandoned. Answers whether the next `openSync`
     * is worth trying immediately: true when the lock is gone (by our hand or
     * somebody else's), false when a holder still owns it.
     *
     * A lock is only ever unlinked by IDENTITY. The token is read when the age
     * is measured and read again immediately before the unlink, and the unlink
     * happens only while the two agree — so a lock that was released and
     * re-taken between the two reads is left to its new holder rather than
     * torn out from under it.
     *
     * THE RESIDUAL RACE, AND WHY IT IS NO LONGER SILENT. The two reads still
     * cannot be fused with the unlink: Node exposes no unlink-by-identity
     * primitive, so in principle a lock can change hands in the instant
     * between the second read and the `rmSync`, leaving two processes inside
     * one critical section. What that can no longer do is lose an admitted
     * attempt. Every state write is preceded by an ownership check, so the
     * process whose lock was broken stops instead of overwriting the breaker's
     * record; and an admission is reported only after the lock is confirmed
     * still ours AND the bytes just written are confirmed still on disk. A
     * violated critical section therefore fails the run loudly with
     * `lock_unavailable`, which is why aggregate admissions cannot exceed the
     * configured rate however the race falls. What remains is the opposite
     * error: a stamp may already be on disk for an attempt the caller was
     * never cleared to make, so the hour can be over-charged by a slot. That
     * is the direction to fail in — an over-charged slot costs the import a
     * wait it makes back, while an under-charged one spends a key the live API
     * shares.
     */
    const breakStaleLock = (): boolean => {
        const measuredToken = readLockToken();

        if (measuredToken === null) {
            return true;
        }

        let ageMs: number;

        try {
            ageMs = Date.now() - fs.statSync(lockFilePath).mtimeMs;
        } catch (error) {
            if (errorCodeOf(error) === 'ENOENT') {
                return true;
            }

            return fail(
                'lock_unavailable',
                `the ledger lock could not be inspected (${errorCodeOf(error) ?? 'unknown error'})`,
            );
        }

        if (!(ageMs > lockStaleMs)) {
            return false;
        }

        const ownership = ledgerLockOwnership(readLockToken(), measuredToken);

        if (ownership === 'reacquired') {
            // Released and re-taken since the age was measured. The lock on
            // disk now belongs to a live holder whose own staleness clock has
            // barely started, so it is not ours to remove.
            return false;
        }

        if (ownership === 'released') {
            return true;
        }

        discard(lockFilePath);

        return true;
    };

    /** One acquisition of the lock: the descriptor to close, and the token that proves it is ours. */
    interface HeldLedgerLock {
        fd: number;
        token: string;
    }

    const acquireLock = async (): Promise<HeldLedgerLock> => {
        for (let attempt = 1; attempt <= lockAttempts; attempt += 1) {
            let fd: number | null = null;

            try {
                fd = fs.openSync(lockFilePath, 'wx', LEDGER_FILE_MODE);
            } catch (error) {
                const code = errorCodeOf(error);
                if (code !== 'EEXIST') {
                    // A missing directory, a read-only filesystem or a
                    // permission failure will not resolve by waiting.
                    fail('lock_unavailable', `the ledger lock could not be created (${code ?? 'unknown error'})`);
                }
            }

            if (fd !== null) {
                const token = mintLockToken();

                try {
                    // Written through the DESCRIPTOR, not the path: it lands in
                    // the inode this call created even if the name is
                    // meanwhile re-pointed at somebody else's lock, so
                    // stamping can never overwrite another holder's token.
                    fs.writeFileSync(fd, `${token}\n`, { encoding: 'utf8' });
                } catch (error) {
                    // An unstamped lock is a lock nothing can prove ownership
                    // of, which is the outcome this whole mechanism exists to
                    // avoid. It is given back directly rather than through
                    // `releaseLock`: this file was created microseconds ago,
                    // so no breaker can have taken it (a lock is only
                    // breakable once it is older than `lockStaleMs`), while
                    // leaving an unidentifiable lock in place would block
                    // every reservation until it aged out.
                    closeLockDescriptor(fd);
                    discard(lockFilePath);
                    fail(
                        'lock_unavailable',
                        `the ledger lock could not be stamped with this reservation's token ` +
                            `(${errorCodeOf(error) ?? 'unknown error'})`,
                    );
                }

                return { fd, token };
            }

            if (breakStaleLock()) {
                // The holder is gone; retry now rather than sleeping out a
                // delay that protects nobody. Still one of the bounded
                // attempts, so a pathological loop cannot spin.
                continue;
            }

            await sleep(lockRetryDelayMs);
        }

        return fail(
            'lock_unavailable',
            `the ledger lock was held by another importer through ${lockAttempts} attempts ` +
                `${lockRetryDelayMs}ms apart`,
        );
    };

    /**
     * Closes the descriptor and removes the lock file — but only while the
     * file still carries our token.
     *
     * Unlinking unconditionally would propagate a violated critical section:
     * if our lock was broken and re-taken, the release would delete the new
     * holder's lock and put a third process inside its critical section. A
     * lock we cannot confirm is ours is therefore left alone; it is stale by
     * definition for whoever does own it, or breakable within `lockStaleMs` if
     * it turns out nobody does.
     */
    const releaseLock = (lock: HeldLedgerLock): void => {
        closeLockDescriptor(lock.fd);

        let observed: string | null;

        try {
            observed = fs.readFileSync(lockFilePath, 'utf8');
        } catch {
            // Deliberately NOT `readLockToken`: releasing happens in a
            // `finally`, and throwing here would replace the reservation's own
            // outcome — the thing the caller has to act on — with a failure to
            // tidy up. An unreadable lock is left in place and recovered by
            // `breakStaleLock` within `lockStaleMs`.
            return;
        }

        if (ledgerLockOwnership(observed, lock.token) === 'held') {
            discard(lockFilePath);
        }
    };

    /**
     * Refuses to continue unless the lock file still carries this
     * reservation's token. `when` names the moment, because the two callers
     * mean different things by a violation: before a write it means the write
     * would clobber another holder's record, and after one it means the record
     * just written cannot be trusted to be the one on disk.
     */
    const requireLockHeld = (lock: HeldLedgerLock, when: string): void => {
        const ownership = ledgerLockOwnership(readLockToken(), lock.token);

        if (ownership === 'held') {
            return;
        }

        fail(
            'lock_unavailable',
            `the ledger lock ${ownership === 'released' ? 'had been removed' : 'had been taken by another importer'} ` +
                `${when}, so this reservation's read-modify-write was not exclusive`,
        );
    };

    const readStamps = (): number[] => {
        let raw: string;

        try {
            raw = fs.readFileSync(stateFilePath, 'utf8');
        } catch (error) {
            if (errorCodeOf(error) === 'ENOENT') {
                // The one benign absence: no file means no importer has spent
                // anything under this scope yet. Every other condition below
                // means a file exists and cannot be believed.
                return [];
            }

            return fail(
                'state_unreadable',
                `the ledger state file exists but could not be read (${errorCodeOf(error) ?? 'unknown error'})`,
            );
        }

        let parsed: unknown;

        try {
            parsed = JSON.parse(raw);
        } catch {
            return fail('state_unparsable', 'the ledger state file is not valid JSON');
        }

        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
            return fail('state_unparsable', 'the ledger state file does not hold a JSON object');
        }

        const document = parsed as Partial<UsdaRateLedgerStateDocument>;

        if (document.version !== USDA_RATE_LEDGER_STATE_VERSION) {
            const declared = document.version === undefined ? 'none' : JSON.stringify(document.version);

            return fail(
                'state_version_unsupported',
                `the ledger state file declares version ${declared}, and this build understands version ` +
                    `${USDA_RATE_LEDGER_STATE_VERSION}`,
            );
        }

        if (typeof document.scope !== 'string') {
            return fail('state_unparsable', 'the ledger state file carries no scope');
        }

        if (document.scope !== scope) {
            return fail(
                'state_scope_mismatch',
                `the ledger state file is scoped to ${JSON.stringify(document.scope)} and this ledger to ` +
                    `${JSON.stringify(scope)}: two scopes resolved to one file, so neither one's hourly ` +
                    `spend can be accounted separately — pass an explicit, distinct stateFilePath for each`,
            );
        }

        const { attempts } = document;
        const usableStamps =
            Array.isArray(attempts) &&
            attempts.every((stamp) => typeof stamp === 'number' && Number.isFinite(stamp));

        if (!usableStamps) {
            // A `null` here is what `JSON.stringify` writes for a NaN or an
            // Infinity, so this also catches a stamp that was corrupt before it
            // was ever persisted. Dropping the bad entries instead would hand
            // back allowance that was already spent.
            return fail(
                'state_unparsable',
                'the ledger state file holds an attempt list that is not all finite numbers',
            );
        }

        return [...attempts];
    };

    let writeSequence = 0;

    /** Returns the exact bytes left on disk, which is what the read-back after an admission compares against. */
    const writeStamps = (stamps: readonly number[]): string => {
        const document: UsdaRateLedgerStateDocument = {
            version: USDA_RATE_LEDGER_STATE_VERSION,
            scope,
            attempts: [...stamps],
        };
        const payload = `${JSON.stringify(document)}\n`;

        // Same directory as the state file, so the rename is within one
        // filesystem and therefore atomic; pid and sequence keep two writers
        // from colliding on the temp name even though the lock already
        // serialises them.
        const tempFilePath = `${stateFilePath}.${process.pid}.${(writeSequence += 1)}.tmp`;

        try {
            fs.writeFileSync(tempFilePath, payload, { encoding: 'utf8', mode: LEDGER_FILE_MODE });
            fs.renameSync(tempFilePath, stateFilePath);
        } catch (error) {
            discard(tempFilePath);
            fail(
                'state_write_failed',
                `the ledger state file could not be written (${errorCodeOf(error) ?? 'unknown error'})`,
            );
        }

        return payload;
    };

    /**
     * Confirms the bytes just written are the bytes on disk.
     *
     * The lock check on its own leaves one silent path: a process whose lock
     * was broken mid-reservation could land its own write over the breaker's,
     * and the breaker's lock file would be untouched by it. Reading the
     * document back closes that by asking the only question that matters —
     * IS THE ATTEMPT RECORDED? — of the state file itself.
     */
    const requireRecorded = (payload: string): void => {
        let raw: string;

        try {
            raw = fs.readFileSync(stateFilePath, 'utf8');
        } catch (error) {
            return fail(
                'state_unreadable',
                `the ledger state file could not be read back after this attempt was recorded ` +
                    `(${errorCodeOf(error) ?? 'unknown error'}), so the attempt cannot be shown to be accounted for`,
            );
        }

        if (raw !== payload) {
            fail(
                'lock_unavailable',
                'the ledger state file no longer holds the record this reservation just wrote: another ' +
                    'importer wrote inside the same critical section, so this attempt is not accounted for',
            );
        }
    };

    const reserve = async (input: UsdaRateLedgerReserveInput): Promise<UsdaRateReservation> => {
        ensureDirectory();

        const lock = await acquireLock();

        try {
            const stamps = readStamps();
            const pruned = pruneAttemptWindow(stamps, input.nowMs, input.windowMs);
            const waitMs = windowWaitMs(pruned, input.nowMs, input.limit, input.windowMs);

            if (waitMs > 0) {
                if (pruned.length !== stamps.length) {
                    // Pruning is persisted even when nothing is admitted, so a
                    // run that spends an hour waiting cannot leave a file full
                    // of stamps that aged out long ago. It is still a write
                    // into the shared document, so it is gated on the lock the
                    // same way an admission's write is: a refusal has nothing
                    // to record, but it must not erase what a concurrent
                    // holder recorded.
                    requireLockHeld(lock, 'before the aged-out stamps were pruned');
                    writeStamps(pruned);
                }

                return { admitted: false, waitMs, attemptsInWindow: pruned.length };
            }

            const recorded = recordAttemptWindow(pruned, input.nowMs, input.windowMs);

            requireLockHeld(lock, 'before this attempt was recorded');
            const payload = writeStamps(recorded);

            // The three conditions an admission is reported under, in order:
            // the record was written, the critical section was still ours when
            // it was, and the record is what the file holds now. Any of the
            // three failing throws instead of admitting, because an admitted
            // attempt this ledger did not account for is the one outcome a
            // rate ledger must never produce.
            requireLockHeld(lock, 'after this attempt was recorded');
            requireRecorded(payload);

            return { admitted: true, waitMs: 0, attemptsInWindow: recorded.length };
        } finally {
            releaseLock(lock);
        }
    };

    return {
        reserve,
        describe: (): UsdaRateLedgerDescription => ({ kind: 'file', scope }),
    };
};

/**
 * Builds a pacer for one import run. Nothing is installed, no environment
 * variable is read and nothing touches the filesystem here — the caller passes
 * the rate in (from `getUsdaImportRateLimitPerHour`) and calls `install()`
 * inside its own flow, so importing this module has no side effect.
 *
 * The hourly ceiling is enforced from DURABLE state by default: with no
 * `ledger` option the limiter builds a `createFileUsdaRateLedger`, so a
 * restart inside the hour and a second importer on the same host are both
 * paced against what has already been spent.
 *
 * @throws RateLimitConfigError when the configuration cannot be honoured.
 */
export const createUsdaRateLimiter = (options: UsdaRateLimiterOptions): UsdaRateLimiter => {
    const requestsPerHour = options.requestsPerHour;
    const vendorCapPerHour = options.vendorCapPerHour ?? USDA_VENDOR_CAP_PER_HOUR;
    // DEFAULTED, the import's ceiling is the LOWER of the two caps. A caller
    // modelling a stricter vendor — a mock server, a key on a reduced quota —
    // must not be refused over a policy cap it never set, and an import may
    // never spend past the vendor's cap whatever the policy number says.
    // PASSED, it is validated rather than clamped: quietly lowering a ceiling
    // an operator chose is how a run ends up paced at a rate nobody asked for.
    const policyCapPerHour = options.policyCapPerHour ?? Math.min(USDA_IMPORT_POLICY_CAP_PER_HOUR, vendorCapPerHour);
    const capacity = options.burstCapacity ?? Math.min(requestsPerHour, DEFAULT_BURST_CAPACITY);
    const logger = options.logger;

    // The cap the offending value was measured against travels on the error, so
    // each rejection below names the bound it actually broke. It defaults to
    // the vendor's because that is the ceiling most of them are about.
    const reject = (message: string, cap: number = vendorCapPerHour): never => {
        throw new RateLimitConfigError(message, requestsPerHour, capacity, cap);
    };

    // No `cap` is named here: the bound a non-integer or non-positive value
    // broke is the shape a rate has to have, not any hourly ceiling, so these
    // keep reporting the vendor cap as the context it always was.
    const requirePositiveInteger = (label: string, value: number): void => {
        if (!Number.isInteger(value) || value <= 0) {
            const observed = Number.isFinite(value) ? `${value}` : 'not a number';
            reject(`${label} must be a positive integer (got ${observed})`);
        }
    };

    requirePositiveInteger('requestsPerHour', requestsPerHour);
    requirePositiveInteger('vendorCapPerHour', vendorCapPerHour);
    requirePositiveInteger('policyCapPerHour', policyCapPerHour);
    // A capacity below one whole token could never be spent, so `acquire`
    // would wait for a token the clamp forbids it to ever hold — an import
    // that hangs instead of running.
    requirePositiveInteger('burstCapacity', capacity);

    // WHY THERE ARE TWO GATES, AND WHY NEITHER IS REDUNDANT.
    //
    // A token bucket with capacity C refilling at rate R admits up to
    // C + R*T requests in any window of length T. So the bucket ALONE cannot
    // hold the importer to `requestsPerHour`: after any idle stretch it stands
    // full, and the hour that follows admits C + R*1h — 20 + 900 = 920 at the
    // defaults, which leaves the live API 80 of USDA's 1,000 instead of the
    // 100 this rate exists to reserve (AAP 0.7.1). The burst allowance is not
    // free; it is a bill the vendor pays on top of the rate.
    //
    // The exact rolling-hour ledger (the `UsdaRateLedger` this limiter
    // reserves from) is therefore the BINDING gate: it admits at most
    // `requestsPerHour` attempts in any hour, idle stretch or not, so 900 is
    // the importer's total and the headroom is real — and because the default
    // ledger is durable, "any hour" means the vendor's hour rather than this
    // process's. The bucket's remaining job is shaping — one detail
    // batch back-to-back, then a smooth one-every-four-seconds pace, instead
    // of 900 requests fired at the vendor in the first second of the hour and
    // then 59 minutes of silence. Delete either one and the module is wrong in
    // a different way: without the ledger the 920 is back, without the bucket
    // the pacing is gone.
    //
    // What the configuration must satisfy is consequently narrower than the
    // old `C + R <= vendorCap`: the ceiling itself has to fit under the
    // IMPORT's cap, that cap has to fit under the vendor's, and the burst has
    // to be spendable within the ceiling.
    //
    // THE THIRD NUMBER, AND WHY IT IS NOT THE VENDOR'S. `requestsPerHour`
    // is checked against `policyCapPerHour`, never against
    // `vendorCapPerHour`: the vendor's cap is what the KEY may spend, and the
    // import is allowed only the part of it that is not reserved for the
    // running API, so a rate of 950 under a cap of 1,000 is a rate the vendor
    // would serve and the live feature would pay for. Checking the policy cap
    // subsumes the vendor check — `requestsPerHour <= policyCapPerHour <=
    // vendorCapPerHour` — which is why there is one comparison here and not
    // two, and why the order below matters: the policy cap is validated
    // against the vendor's FIRST, so a caller cannot widen the ceiling by
    // passing a policy cap of its own. That direction is a misconfiguration
    // and is refused; passing a LOWER one is the option the parameter exists
    // for.
    if (policyCapPerHour > vendorCapPerHour) {
        reject(
            `policyCapPerHour ${policyCapPerHour} exceeds vendorCapPerHour ${vendorCapPerHour}: the import's ` +
                `own ceiling is a share of the vendor's hourly cap and can only be lower than it, so a larger ` +
                `one is a misconfiguration rather than a wider allowance`,
        );
    }
    // AND IT CANNOT BE RAISED PAST THE PRODUCT POLICY EITHER. Bounding the
    // option only by the vendor's cap would leave the 900 guarantee resting on
    // caller discipline: `policyCapPerHour: 1000` sits under a vendor cap of
    // 1,000 and hands the live API's 100 straight back, which is the same
    // defect as a ceiling that is merely a default, one layer up. The option
    // exists to go LOWER — a smoke run beside a busy environment — so lower is
    // all it can do, and raising the import's share is a code change made here
    // with the headroom argument in front of you, not a constructor argument.
    if (policyCapPerHour > USDA_IMPORT_POLICY_CAP_PER_HOUR) {
        reject(
            `policyCapPerHour ${policyCapPerHour} exceeds the import ceiling of ` +
                `${USDA_IMPORT_POLICY_CAP_PER_HOUR} requests/hour: an import may be paced SLOWER than the ` +
                `policy ceiling but never faster, because the ` +
                `${USDA_VENDOR_CAP_PER_HOUR - USDA_IMPORT_POLICY_CAP_PER_HOUR}/hour above it are the running ` +
                `API's share of the same key`,
            USDA_IMPORT_POLICY_CAP_PER_HOUR,
        );
    }
    if (requestsPerHour > policyCapPerHour) {
        reject(
            `requestsPerHour ${requestsPerHour} exceeds policyCapPerHour ${policyCapPerHour}: the importer's ` +
                `rolling-hour ceiling is the total it may spend, and it is capped below the vendor's ` +
                `${vendorCapPerHour}/hour so the remaining ${vendorCapPerHour - policyCapPerHour}/hour stay ` +
                `available to the running API's traffic on the same key`,
            policyCapPerHour,
        );
    }
    // A burst wider than the hourly ceiling can never be spent in full — the
    // ledger stops it at `requestsPerHour` — so configuring one asks for
    // allowance that does not exist, and the extra capacity would only delay
    // the pacing the bucket is there to provide.
    if (capacity > requestsPerHour) {
        reject(
            `burstCapacity ${capacity} exceeds requestsPerHour ${requestsPerHour}: the rolling-hour ` +
                `ledger admits at most requestsPerHour attempts per hour, so a wider burst can never ` +
                `be spent in full`,
        );
    }

    const host = normalizeHost(options.host ?? USDA_HOST);
    // An unusable host matches nothing, which would leave every USDA request
    // unpaced — the same outcome as not installing the limiter at all, but
    // silent. The raw value is not echoed: a base URL can carry userinfo.
    if (host.length === 0) {
        reject('host must be a hostname or a base URL; an unusable host would leave every request unpaced');
    }

    const tokensPerMs = requestsPerHour / MS_PER_HOUR;
    const now = options.now ?? ((): number => Date.now());
    const sleep = options.sleep ?? defaultSleep;

    // DURABLE BY DEFAULT. A caller that passes nothing but a rate gets the
    // file ledger, because the caller that matters — the catalog importer — is
    // a multi-hour run that is expected to be interrupted and resumed, and an
    // in-memory ledger would hand each resumption a fresh hourly allowance.
    // Constructing it does no I/O; the directory and the state file appear on
    // the first reservation. The limiter's own `sleep` is passed through so a
    // test that makes pacing instant also makes lock contention instant.
    const ledger =
        options.ledger ??
        createFileUsdaRateLedger({
            scope: options.ledgerScope ?? DEFAULT_USDA_RATE_LEDGER_SCOPE,
            stateFilePath: options.ledgerStateFilePath,
            sleep,
        });

    // Keeps every downstream calculation finite even if an injected clock
    // misbehaves; the loop in `acquire` still relies on the clock advancing.
    const readClock = (): number => {
        const reading = now();
        return Number.isFinite(reading) ? reading : 0;
    };

    // The bucket starts full so the first detail batch is not made to wait for
    // allowance the importer has not yet spent.
    let state: BucketState = { tokens: capacity, lastRefillMs: readClock() };

    const counters = {
        attempts: 0,
        // Charged in `paced`, one bucket per admitted attempt, so these two
        // account for exactly the same physical requests `attempts` counts
        // (UsdaRequestStats's identity). Nothing else may touch them: a count
        // taken anywhere but around the gated call would either double-charge
        // an attempt or charge one the limiter never admitted.
        statusClassCounts: emptyStatusClassCounts(),
        transportFailures: 0,
        pauses: 0,
        totalPausedMs: 0,
        longestPauseMs: 0,
        firstAttemptAt: null as string | null,
        lastAttemptAt: null as string | null,
        // The ledger's view of the rolling hour at the most recent
        // reservation, which is the only place this process learns it: the
        // stamps live in the ledger, and for the durable one they include what
        // other processes and earlier runs spent.
        attemptsInWindow: 0,
    };

    const recordAttempt = (nowMs: number): void => {
        counters.attempts += 1;
        const at = isoOf(nowMs);
        if (counters.firstAttemptAt === null) {
            counters.firstAttemptAt = at;
        }
        counters.lastAttemptAt = at;
    };

    // Reads the ONE header field the accounting needs and nothing else. The
    // body is never read, never cloned and never buffered, so the response the
    // caller receives is untouched — which is the constraint that makes
    // counting here safe at all: a limiter that consumed a response to classify
    // it would break every caller downstream of it.
    //
    // The defensive read is not ceremony. `Response.status` is typed `number`,
    // but this sees whatever the installed transport resolved, and an attempt
    // already charged to the hour must land in a bucket whatever that turns out
    // to be (see `usdaStatusClass`).
    const recordStatus = (response: unknown): void => {
        const status = (response as { status?: unknown } | null | undefined)?.status;
        counters.statusClassCounts[usdaStatusClass(status)] += 1;
    };

    const recordPause = (waitMs: number): void => {
        counters.pauses += 1;
        if (Number.isFinite(waitMs)) {
            counters.totalPausedMs += waitMs;
            counters.longestPauseMs = Math.max(counters.longestPauseMs, waitMs);
        }
    };

    // One line per pause, never per request: at 900 requests an hour a
    // per-request line is ~900 lines that bury the pauses, which are the only
    // thing here an operator has to act on. Logged before the wait so a live
    // run shows the pause while it is happening. Which gate held is the one
    // thing an operator needs from it: 'burst' is the pacer doing its job
    // between batches, while 'hourly_ceiling' means the hourly allowance is
    // spent and the run is waiting for the oldest attempt to age out.
    const pause = async (reason: 'burst' | 'hourly_ceiling', requestedMs: number): Promise<void> => {
        // A gate that reports "not yet" and "wait no time" would spin hot. The
        // module's own two gates cannot: `waitMsForToken` returns a positive
        // wait or zero, and `windowWaitMs` floors a non-zero wait at 1ms. The
        // floor is here because an INJECTED ledger is a third implementation
        // this module does not own, and a spin is a worse failure than a
        // millisecond of unnecessary sleep.
        const waitMs = Number.isFinite(requestedMs) && requestedMs > 0 ? requestedMs : 1;

        recordPause(waitMs);
        logger?.info('usda_rate_limit_pause', {
            waitMs,
            reason,
            attempts: counters.attempts,
            attemptsInWindow: counters.attemptsInWindow,
            configuredPerHour: requestsPerHour,
        });
        await sleep(waitMs);
    };

    // An exhausted gate answers "later", never "no": the import pauses rather
    // than failing, because aborting a multi-hour run over allowance it will
    // have again in seconds is strictly worse than waiting for it. Looping
    // rather than sleeping once is deliberate — a coarse timer can wake early,
    // and a wait satisfying one gate can leave the other short.
    //
    // THE ORDER OF THE TWO GATES IS LOAD-BEARING. The bucket is checked and
    // waited out FIRST, and only then is a ledger slot reserved, because
    // `reserve` RECORDS what it admits: reserving before the bucket was ready
    // would charge the hour for a request that is still seconds away from
    // going out, and a run that then failed for another reason would have
    // spent allowance it never used. Reserving last means the only gap between
    // recording an attempt and making it is the `return` below.
    const acquireExclusive = async (): Promise<void> => {
        for (;;) {
            const nowMs = readClock();
            state = refillBucket(state, nowMs, tokensPerMs, capacity);

            const bucketWaitMs = waitMsForToken(state, nowMs, tokensPerMs, capacity);
            if (bucketWaitMs > 0) {
                await pause('burst', bucketWaitMs);
                continue;
            }

            const reservation = await ledger.reserve({
                nowMs,
                limit: requestsPerHour,
                windowMs: RATE_WINDOW_MS,
            });
            counters.attemptsInWindow = reservation.attemptsInWindow;

            // An admitted attempt is charged to both gates: the ledger already
            // recorded its stamp, and the token is spent here. Charging only
            // the bucket is what let an idle-then-burst run reach C + R*T.
            if (reservation.admitted) {
                state = { tokens: state.tokens - 1, lastRefillMs: state.lastRefillMs };
                recordAttempt(nowMs);
                return;
            }

            await pause('hourly_ceiling', reservation.waitMs);
        }
    };

    // ONE ACQUISITION AT A TIME, IN ARRIVAL ORDER. `acquireExclusive` awaits in
    // the middle of a decision — the ledger reservation sits between the burst
    // check and the token decrement — so the two are not atomic on their own.
    // Unqueued, two concurrent callers would both pass the burst check on the
    // same token and both spend it, admitting a burst wider than `capacity` and
    // handing the vendor the C + R*T the ledger exists to prevent. The chain
    // makes each acquisition wait for the previous one, and FIFO order is what
    // keeps the pacing fair between concurrent batch fetches rather than
    // starving whichever caller is unlucky.
    //
    // The tail never rejects: a caller whose acquisition failed (an unusable
    // ledger) must not make every later caller fail with the same error, so the
    // queue swallows the outcome it chains on while the returned promise still
    // carries the rejection to the caller that owns it.
    let queue: Promise<unknown> = Promise.resolve();

    const acquire = (): Promise<void> => {
        const acquisition = queue.then(() => acquireExclusive());
        queue = acquisition.then(
            () => undefined,
            () => undefined,
        );

        return acquisition;
    };

    type FetchFn = typeof globalThis.fetch;

    let restoreInstalled: (() => void) | null = null;

    const install = (): (() => void) => {
        // Installing twice would wrap the wrapper and spend two tokens per
        // request, silently halving the configured rate — so a second call is
        // the same installation, not a new one.
        if (restoreInstalled !== null) {
            return restoreInstalled;
        }

        // Captured at install time, not at module load, so whatever is
        // currently installed is what the wrapper delegates to.
        const original: FetchFn = globalThis.fetch;
        let active = true;

        // Gating `globalThis.fetch` is what makes the accounting per PHYSICAL
        // request. `usda.service.ts` retries up to four times around its own
        // `fetch` call, so wrapping its exported functions would count one
        // logical lookup and miss up to three real vendor requests; it also
        // catches the background cache refresh, which no service call fronts,
        // and correctly counts nothing for a cache hit that never fetches.
        //
        // BEING AT THE TRANSPORT IS ALSO WHAT MAKES THE STATUS SPLIT POSSIBLE.
        // This wrapper holds the `Response` the delegate returned, and
        // `status` is a header field: reading it touches nothing a caller will
        // later consume, while the retry ladder inside `usda.service.ts`
        // resolves several physical answers into one logical outcome and can
        // therefore no longer say how many of them were 429s. So the count
        // that the import report needs exists in exactly one place, and this
        // is it.
        const paced = async (...args: Parameters<FetchFn>): ReturnType<FetchFn> => {
            // Everything that is not USDA traffic — OpenRouter, evidence
            // retrieval — passes straight through: no token, no stats, no log
            // line, no delay. It is not awaited here either, so nothing about
            // its timing or its errors changes.
            if (!isUsdaRequestUrl(args[0], host)) {
                return original(...args);
            }

            await acquire();

            // From here the attempt is charged to `attempts`, so it must be
            // charged to exactly one bucket as well — a status class if the
            // delegate answers, a transport failure if it throws.
            try {
                const response = await original(...args);
                recordStatus(response);
                return response;
            } catch (error) {
                counters.transportFailures += 1;
                // Rethrown exactly as caught. Vendor and transport failures
                // stay the vendor boundary's business (§9): `usda.service.ts`
                // decides what a failure means and whether to retry it, and an
                // error reshaped, wrapped or logged here would either change
                // that decision or put a URL carrying `api_key` into a log.
                throw error;
            }
        };

        const restore = (): void => {
            // Safe to call twice: once it has handed the global back, what is
            // installed by then is somebody else's business.
            if (!active) {
                return;
            }

            // Deliberately narrow, and this identity check is the whole of it:
            // the original goes back only while the global is still OUR
            // wrapper. Anything installed on top of it — a sibling limiter, a
            // test transport, an instrumentation hook — owns `globalThis.fetch`
            // now, and assigning `original` over that would silently disable a
            // wrapper this module knows nothing about. `Object.assign` returns
            // its target, so the value installed below is `paced` itself.
            if (globalThis.fetch !== paced) {
                // `active` and `restoreInstalled` stay set on purpose, which
                // keeps both halves of the contract: `install` still refuses to
                // wrap twice, and a later `restore` succeeds once the newer
                // owner steps down and our wrapper is the global again. Host
                // only, never a URL — a USDA URL carries `api_key`.
                logger?.debug('usda_rate_limit_restore_skipped', {
                    host,
                    reason: 'foreign_fetch_owner',
                });
                return;
            }

            active = false;
            restoreInstalled = null;
            globalThis.fetch = original;
        };

        // Carries the real fetch's own enumerable properties across. On Node
        // 22 that copies nothing (fetch has none), but a runtime attaching a
        // helper such as undici's `preconnect` would otherwise lose it behind
        // the wrapper. No cast is needed — lib.dom types fetch as a plain
        // function, verified by compiling.
        globalThis.fetch = Object.assign(paced, original);
        restoreInstalled = restore;

        // The ledger's kind and scope, never its state path: a path can carry a
        // home directory, and this line reaches terminals, CI output and
        // committed reports.
        const ledgerDescription = ledger.describe();

        logger?.debug('usda_rate_limit_installed', {
            host,
            configuredPerHour: requestsPerHour,
            burstCapacity: capacity,
            // Both ceilings, because the enforced one is the policy cap and a
            // line carrying only the vendor's would leave an operator reading
            // the run's headroom off the wrong number.
            policyCapPerHour,
            vendorCapPerHour,
            ledgerKind: ledgerDescription.kind,
            ledgerScope: ledgerDescription.scope,
        });

        return restore;
    };

    // `describe()` is read here rather than captured at construction so the
    // report says which pacing was actually in force, including for a ledger
    // injected by a caller this module knows nothing about.
    const stats = (): UsdaRequestStats => {
        const ledgerDescription = ledger.describe();

        return {
            configuredPerHour: requestsPerHour,
            vendorCapPerHour,
            policyCapPerHour,
            burstCapacity: capacity,
            attempts: counters.attempts,
            // Copied, not handed out. The importer spreads this object into a
            // committed JSON report, and a caller holding the live counter
            // object could alter what the run then reports about itself.
            statusClassCounts: { ...counters.statusClassCounts },
            transportFailures: counters.transportFailures,
            pauses: counters.pauses,
            totalPausedMs: counters.totalPausedMs,
            longestPauseMs: counters.longestPauseMs,
            firstAttemptAt: counters.firstAttemptAt,
            lastAttemptAt: counters.lastAttemptAt,
            ledgerKind: ledgerDescription.kind,
            ledgerScope: ledgerDescription.scope,
            attemptsInWindow: counters.attemptsInWindow,
        };
    };

    return { acquire, install, stats };
};
