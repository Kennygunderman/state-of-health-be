/**
 * The development seed stage: `scripts/seed-dev.ts`.
 *
 * WHAT THIS SUITE SETTLES. Three properties of the one command that writes
 * USER-SCOPED rows, and nothing wider.
 *
 *  1. WHAT IT MAY LOG. `--email` and `--user-id` are operator-supplied, and the
 *     second is a Firebase uid in production, so no field this stage emits may
 *     carry either value — nor a nutrition target, a stored weight or a diary
 *     bucket name. The stage builds its log fields in three exported pure
 *     functions (`invocationFields`, `completionFields`, `failureFields`) and
 *     `main` hands their result to the logger unchanged, so asserting them is
 *     asserting the emitted line rather than a restatement of it. Both the
 *     default identity and a supplied one are covered, because the defaulting
 *     rule (`resolveIdentity`) is where a caller-supplied value enters. On the
 *     FAILURE path the text is not the stage's to compose, and the rule there
 *     is PROVENANCE: a message written in this repository is forwarded, a
 *     message Prisma or the runtime composed is withheld in favour of the
 *     class, the code, a remedy and the phase. Both halves are pinned against
 *     real Prisma errors, including one whose identity carries a quote, a
 *     backslash and a control character — the spelling a literal redactor
 *     cannot match, and the reason redaction is the second line here rather
 *     than the guarantee.
 *  2. WHAT IT LOCKS. Its transaction mutates exactly the rows Agent Action Plan
 *     §0.5.1's "lock first" rule covers — `meal_plan_preferences` with its
 *     `confirmed_targets` snapshot, the four `users.target_*` columns, the diary
 *     buckets, the weigh-in, and a `--reset-user` delete that cascades to
 *     plans, groceries and the action ledger — so it must take the same
 *     `pg_advisory_xact_lock(hashtext('meal-planning:' || userId))` the request
 *     path takes, as its first statement. That is observed from a SECOND
 *     PostgreSQL session: `pg_locks` is POLLED until it shows the exact
 *     contention on that key — the holder granted and the seed ungranted — and
 *     that waiter's existence, never a pause of any length, is what establishes
 *     the seed is blocked. The counter-proof — the same run completing when
 *     nothing holds the lock — is what stops the first assertion passing for an
 *     incidental reason. Neither case measures how long anything took, so
 *     neither can fail because the host was loaded.
 *  3. THAT A RERUN CHANGES NOTHING, asserted on the ROWS rather than on the log,
 *     and that `--reset-user` returns the user to the declared state.
 *
 * WHAT THIS SUITE DELIBERATELY DOES NOT SETTLE. The database-origin policy
 * (`seed-dev` is `development_only`, `--confirm-target` is refused) belongs to
 * `scripts/lib/dbGuard`'s own coverage and to `recipes-seed.test.ts`'s policy
 * block, which spawns the real command; nothing here re-derives it. The catalog
 * and recipe corpora this stage deliberately does not seed are
 * `catalog-load.test.ts`'s and `recipes-seed.test.ts`'s subjects. The planner
 * behaviour the seeded user unlocks — that these preferences and targets really
 * do generate a week — is `api/plans.test.ts`'s.
 *
 * WHY IT DRIVES `runSeed(options)` RATHER THAN THE COMMAND. `main()` reads
 * `process.argv`, classifies the ambient `DATABASE_URL` and calls
 * `process.exit`, none of which a test may do; `runSeed` takes its Prisma
 * client, its clock, its identity and its day as dependencies for exactly this
 * reason, so every case below runs the production path with nothing stubbed but
 * those four seams. The argument parser, the day-key parser and the field
 * builders are pure and are covered directly.
 *
 * SAFETY AND ISOLATION. Every block truncates through
 * `setup/testDb.ts::truncateFeatureTables`, which re-runs the identity guard
 * (`NODE_ENV=test`, `ALLOW_DB_TRUNCATE=true`, a `_test`-class name on a local
 * host) and the schema-freshness gate. `FEATURE_TABLES` includes `users` and
 * `meals`, and `body_weight_entries` cascades from `users`, so no row this
 * stage writes outlives a block. Run it with:
 *
 *   NODE_ENV=test ALLOW_DB_TRUNCATE=true \
 *     DATABASE_URL=postgresql://…@127.0.0.1:5433/<name>_test \
 *     npx jest --ci --runInBand src/__tests__/scripts/seed-dev.test.ts
 */
import { createHash } from 'node:crypto';

import { createFatalLogger } from '../../../scripts/lib/logger';
import type { LogFields } from '../../../scripts/lib/logger';
import {
    completionFields,
    DEFAULT_DEV_USER_EMAIL,
    DEFAULT_DEV_USER_ID,
    DEV_TARGETS,
    DIARY_MEAL_NAMES,
    failureFields,
    invocationFields,
    parseArgs,
    parseDayKey,
    redactIdentity,
    resolveIdentity,
    runSeed,
    SeedDevError,
    userRef,
} from '../../../scripts/seed-dev';
import type { DevelopmentIdentity, SeedOptions, SeedPhase, SeedSummary } from '../../../scripts/seed-dev';
import { Prisma, PrismaClient } from '../../generated/prisma';
import { prisma } from '../../prisma/client';
import { truncateFeatureTables } from '../setup/testDb';

/** Database work per block is a handful of small statements; a hang is worth failing. */
const BLOCK_TIMEOUT_MS = 120_000;

/** A case that waits on a lock another session holds needs more than Jest's 5 s default. */
const LOCK_CASE_TIMEOUT_MS = 30_000;

/**
 * How often `pg_locks` is re-read while waiting for the blocked seed to appear
 * on the key.
 *
 * It is a POLL RESOLUTION and not a threshold: the assertion below is the
 * ungranted waiter's existence, so this value decides only how soon that waiter
 * is noticed, never whether the case passes. Small, because the waiting seed is
 * spending Prisma's 5 s interactive-transaction budget while it waits and the
 * holder should be released promptly once the contention has been observed.
 */
const LOCK_POLL_INTERVAL_MS = 25;

/**
 * The HANG GUARD on that poll — deliberately not an assertion about speed.
 *
 * Two thirds of the case's own timeout, derived from it rather than written as
 * a second number, so there is one threshold to change and the guard can never
 * outlive the case it guards. Its only job is to stop a wedged run from
 * consuming the suite: a blocked seed appears on the key in milliseconds, and a
 * build that had stopped taking the lock is caught by the
 * settled-without-waiting check in `awaitContendedUserKey` rather than by this
 * expiring.
 */
const WAITER_GUARD_MS = Math.floor((LOCK_CASE_TIMEOUT_MS * 2) / 3);

/**
 * The seed instant, pinned like every other database-backed suite's clock so
 * `body_weight_entries.logged_at` is an exactly assertable value rather than one
 * that moves with the run.
 */
const SEEDED_AT = new Date('2026-09-20T09:15:00.000Z');

/** A second instant, so a rerun's clock is distinguishable from the first run's. */
const RESEEDED_AT = new Date('2026-09-21T18:40:00.000Z');

/**
 * The diary day every block seeds. Chosen to share no digit sequence with the
 * target values or the stored weight, so the "no value appears in the log"
 * assertions cannot pass or fail on the date.
 */
const DAY_KEY = '2026-09-20';

/**
 * The identity this suite exists for: a real-shaped Firebase uid and a real
 * mailbox, as supplied by an operator who pointed the seeder at their own
 * signed-in account.
 */
const SUPPLIED_ARGV: readonly string[] = [
    '--user-id',
    'firebase-uid-8Qd2mKpL0aXvZ3',
    '--email',
    'real.developer@company.example',
];

/**
 * The pounds reading `seed-dev.ts` declares for the weigh-in. Restated here on
 * purpose: it is a development CONSTANT, and a change to it should have to be
 * acknowledged where the row is asserted.
 */
const DECLARED_WEIGH_IN_WEIGHT = 182.2;

/**
 * How many connections the second session below may open.
 *
 * Prisma sizes a client's pool at `cpus * 2 + 1` unless told otherwise — 25 on
 * a 12-core runner — and this suite already holds one such pool through the
 * singleton. An unbounded second client would therefore claim a second 25
 * against a PostgreSQL whose `max_connections` is shared with every other
 * suite and, on CI, every other job on the host; the cap is then reached by
 * whichever suite happens to ask next, which reports it as
 * `FATAL: sorry, too many clients already` far from the client that took the
 * connections.
 *
 * Two are genuinely concurrent here: the transaction {@link holdUserLock}
 * leaves open, and the `pg_locks` read that runs while it is open. The third
 * is headroom. Exhausting the bound is an explicit `P2024` pool timeout rather
 * than a hang, so a future third concurrent use on this client fails loudly
 * instead of being hidden by the bound.
 */
const CONTENDING_CLIENT_CONNECTION_LIMIT = 3;

/** The ambient test datasource, bounded to {@link CONTENDING_CLIENT_CONNECTION_LIMIT}. */
const boundedDatasourceUrl = (): string => {
    const configured = process.env.DATABASE_URL;

    if (configured === undefined || configured === '') {
        // Unreachable through `npm test`: `jestSetup.ts` runs
        // `assertTestDatabase()` before any module loads and refuses a run
        // whose DATABASE_URL is missing or unusable.
        throw new Error('DATABASE_URL is not set, so the contending client cannot be bounded');
    }

    const url = new URL(configured);
    url.searchParams.set('connection_limit', String(CONTENDING_CLIENT_CONNECTION_LIMIT));

    return url.toString();
};

/**
 * A second session, so the per-user advisory lock can be held from OUTSIDE the
 * transaction under test. Query logging is not needed, so this client differs
 * from the singleton only in the connection bound above.
 */
const contendingClient = new PrismaClient({ datasourceUrl: boundedDatasourceUrl() });

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** A promise plus its resolver, for sequencing two sessions without a sleep. */
const deferred = (): { promise: Promise<void>; release: () => void } => {
    let release = (): void => undefined;
    const promise = new Promise<void>((resolve) => {
        release = () => resolve();
    });

    return { promise, release };
};

/** Tracks whether a promise has settled, without awaiting it. */
const watch = <T>(promise: Promise<T>): { settled: () => boolean; done: Promise<T> } => {
    let finished = false;
    const done = promise.finally(() => {
        finished = true;
    });

    return { settled: () => finished, done };
};

/** The parsed options of an accepted command line, or a failure naming what it refused. */
const optionsOf = (argv: readonly string[]): SeedOptions => {
    const parsed = parseArgs(argv);

    if (!parsed.ok) {
        throw new Error(
            `parseArgs refused "${argv.join(' ')}", which this case needs it to accept: ` +
                parsed.errors.map((failure) => `${failure.flag}: ${failure.message}`).join('; '),
        );
    }

    return parsed.options;
};

/** One seed run against the real test database, on the injected clock. */
const seed = (identity: DevelopmentIdentity, options?: { now?: Date; resetUser?: boolean }): Promise<SeedSummary> =>
    runSeed({
        client: prisma,
        now: () => options?.now ?? SEEDED_AT,
        identity,
        dayKey: DAY_KEY,
        resetUser: options?.resetUser ?? false,
    });

/**
 * Every emitted field, keys and values together, as one string.
 *
 * `JSON.stringify` rather than a walk over the top level: `failureFields` nests
 * the error's name and message, and a leak inside a nested value is the leak
 * this suite is about. A needle absent from this string is absent from the line.
 */
const emitted = (fields: LogFields): string => JSON.stringify(fields);

/**
 * One value as a vendor that SERIALIZES its call arguments writes it.
 *
 * `JSON.stringify` of a string, less its surrounding quotes, is exactly the
 * escaping `PrismaClientValidationError` applies: a quote becomes `\"`, a
 * backslash `\\`, and a control character `\u0007`. So this is the needle a
 * literal redactor does not hold — the finding's whole mechanism — and the
 * cases below pin it against a real Prisma message rather than assuming it.
 */
const prismaEscaped = (value: string): string => JSON.stringify(value).slice(1, -1);

/**
 * The failure line EXACTLY as the stage writes it: `main`'s catch is
 * `createFatalLogger(STAGE).error('stage_failed', failureFields(…))`, and this
 * is that call with the terminal swapped for an array.
 *
 * Preferred over `emitted()` for the leak assertions, because it is the real
 * serializer: the logger sanitizes fields, renames a caller key that would
 * collide with the line's own metadata, and JSON-encodes the result. A needle
 * absent from this string is absent from what an operator's scrollback, `tee`'d
 * file or CI log would hold.
 */
const capturedFailureLine = (
    error: unknown,
    identity: DevelopmentIdentity | null,
    phase: SeedPhase | null = null,
): string => {
    const written: string[] = [];
    const logger = createFatalLogger('seed-dev', {
        write: (line: string): void => {
            written.push(line);
        },
    });

    logger.error('stage_failed', failureFields(error, identity, phase));

    expect(written).toHaveLength(1);

    return written[0];
};

/**
 * The user-specific values a log line must report as a CODE if at all: the four
 * declared targets, the stored weight, and the names of the diary buckets.
 */
const HEALTH_SHAPED_VALUES: readonly string[] = [
    String(DEV_TARGETS.calories),
    String(DEV_TARGETS.protein),
    String(DEV_TARGETS.carbs),
    String(DEV_TARGETS.fat),
    String(DECLARED_WEIGH_IN_WEIGHT),
    ...DIARY_MEAL_NAMES,
];

/**
 * The whole assertion this suite's first property rests on, applied to one set
 * of emitted fields.
 *
 * The two IDENTITY values are long and unmistakable, so the entire serialized
 * line — nested error object included — is searched for them. The HEALTH-SHAPED
 * values are short numbers, and `userRef` is a hex digest whose characters are
 * not data: "57" occurring inside a digest is an artefact of hashing, not the
 * fat target. So those are checked field by field against every field except
 * the digest, a number by value and a string by containment, which is what "the
 * line reports outcome codes rather than values" actually asserts.
 */
const expectNothingIdentifying = (fields: LogFields, identity: DevelopmentIdentity): void => {
    const line = emitted(fields);

    expect(line).not.toContain(identity.userId);
    expect(line).not.toContain(identity.email);

    for (const [key, value] of Object.entries(fields)) {
        if (key === 'userRef') {
            continue;
        }

        for (const forbidden of HEALTH_SHAPED_VALUES) {
            if (typeof value === 'number') {
                expect(value).not.toBe(Number(forbidden));
            } else {
                // `?? String(value)` because `JSON.stringify(undefined)` is
                // `undefined` rather than a string, and `remedy` is absent on
                // most failures.
                expect(JSON.stringify(value) ?? String(value)).not.toContain(forbidden);
            }
        }
    }
};

afterAll(async () => {
    await truncateFeatureTables();
    await contendingClient.$disconnect();

    // Both clients, not just the second one. `--runInBand` runs every suite in
    // one worker process and gives each its own module registry, so this file's
    // `prisma` singleton is a distinct engine holding its own connections;
    // leaving it open would keep them for the rest of the run and add this
    // suite to the pool pressure the bound above exists to relieve.
    // Disconnecting here cannot affect another suite, whose singleton is a
    // different instance. `api/catalogCollation.test.ts` does the same.
    await prisma.$disconnect();
});

/* ---------------------------------------------------------------------------
 * What a log line may carry
 * ------------------------------------------------------------------------- */

describe('userRef, the only form of an identity this stage logs', () => {
    it('is the first twelve hex characters of the SHA-256 of the user id', () => {
        const userId = 'firebase-uid-8Qd2mKpL0aXvZ3';

        // Computed independently rather than re-read from the module, so the
        // construction itself is pinned: a change of algorithm, encoding or
        // length fails here instead of silently producing a different opaque
        // string that still looks like a fingerprint.
        const expectedDigest = createHash('sha256').update(userId, 'utf8').digest('hex').slice(0, 12);

        expect(userRef(userId)).toBe(expectedDigest);
        expect(userRef(userId)).toMatch(/^[0-9a-f]{12}$/);
    });

    it('is stable across calls, so two runs for the same developer correlate', () => {
        expect(userRef(DEFAULT_DEV_USER_ID)).toBe(userRef(DEFAULT_DEV_USER_ID));
    });

    it('differs for a different user id, so two developers never look like one', () => {
        expect(userRef(DEFAULT_DEV_USER_ID)).not.toBe(userRef('firebase-uid-8Qd2mKpL0aXvZ3'));
    });

    it('carries no part of the id it stands for', () => {
        const userId = 'dev-seed-user';

        expect(userRef(userId)).not.toContain(userId);
        // Nor any word of it: the value is a digest, so no fragment of the
        // input can survive into it.
        expect(userRef(userId)).not.toContain('seed');
    });
});

describe('the invocation line', () => {
    it('reports the default identity as a fingerprint and nothing else about it', () => {
        const identity = resolveIdentity(optionsOf([]));

        expect(identity).toEqual({ userId: DEFAULT_DEV_USER_ID, email: DEFAULT_DEV_USER_EMAIL });

        const fields = invocationFields({ identity, dayKey: DAY_KEY, resetUser: false });

        expect(fields).toEqual({
            stage: 'seed-dev',
            userRef: userRef(DEFAULT_DEV_USER_ID),
            date: DAY_KEY,
            resetUser: false,
        });
        expectNothingIdentifying(fields, identity);
    });

    it('reports a supplied --email and --user-id the same way', () => {
        const identity = resolveIdentity(optionsOf(SUPPLIED_ARGV));

        expect(identity).toEqual({
            userId: 'firebase-uid-8Qd2mKpL0aXvZ3',
            email: 'real.developer@company.example',
        });

        const fields = invocationFields({ identity, dayKey: DAY_KEY, resetUser: true });

        expect(fields.userRef).toBe(userRef('firebase-uid-8Qd2mKpL0aXvZ3'));
        expect(fields.resetUser).toBe(true);
        expectNothingIdentifying(fields, identity);
    });
});

describe('the completion line, over a real run', () => {
    const identity = resolveIdentity(optionsOf(SUPPLIED_ARGV));
    let summary: SeedSummary;

    beforeAll(async () => {
        await truncateFeatureTables();
        summary = await seed(identity);
    }, BLOCK_TIMEOUT_MS);

    it('describes the run it really performed', () => {
        expect(summary).toEqual({
            userId: identity.userId,
            date: DAY_KEY,
            userReset: false,
            userOutcome: 'created',
            preferencesOutcome: 'created',
            mealsCreated: [...DIARY_MEAL_NAMES],
            mealsExisting: [],
            weighInOutcome: 'created',
            changed: true,
        });
    });

    it('hands back no email, so no later caller can log one by accident', () => {
        expect(Object.keys(summary)).not.toContain('email');
    });

    it('emits outcome codes and counts, with no identity, target value or bucket name', () => {
        const fields = completionFields(summary);

        expect(fields).toEqual({
            stage: 'seed-dev',
            userRef: userRef(identity.userId),
            date: DAY_KEY,
            changed: true,
            userReset: false,
            users: 'created',
            mealPlanPreferences: 'created',
            targetSource: 'estimated',
            bodyWeightEntries: 'created',
            mealsCreatedCount: 4,
            mealsExistingCount: 0,
        });
        expectNothingIdentifying(fields, identity);
    });

    it('reports the same fingerprint on a second run for the same developer', async () => {
        const rerun = await seed(identity, { now: RESEEDED_AT });

        expect(completionFields(rerun).userRef).toBe(completionFields(summary).userRef);
        expectNothingIdentifying(completionFields(rerun), identity);
    });

    it('reports a different fingerprint for a different user id', async () => {
        const other = resolveIdentity(
            optionsOf(['--user-id', 'firebase-uid-OTHER-0001', '--email', 'other@soh.invalid']),
        );
        const otherSummary = await seed(other);

        expect(completionFields(otherSummary).userRef).not.toBe(completionFields(summary).userRef);
        expectNothingIdentifying(completionFields(otherSummary), other);
    });
});

/* ---------------------------------------------------------------------------
 * What a failure line may carry
 * ------------------------------------------------------------------------- */

describe('the failure line', () => {
    const identity = resolveIdentity(optionsOf(SUPPLIED_ARGV));

    beforeAll(async () => {
        await truncateFeatureTables();
    }, BLOCK_TIMEOUT_MS);

    /**
     * A REAL `PrismaClientValidationError`, raised by a call whose arguments
     * carry the given identity.
     *
     * The cast is the point rather than a convenience: Prisma's validation
     * message SERIALIZES the arguments of the rejected call — measured against
     * this schema, `id: "<uid>", email: "<address>"` appear inside it — and a
     * type-correct call cannot produce one. Reaching that message with a real
     * error is what makes the assertions below evidence rather than statements
     * about a string a test wrote itself, and it is the only way to observe
     * what Prisma does to a hostile value on the way in: a hand-built `Error`
     * carries whatever text the test chose, which is precisely not the defect.
     */
    const validationFailure = async (subject: DevelopmentIdentity): Promise<unknown> => {
        const untyped = prisma.users as unknown as { create: (args: unknown) => Promise<unknown> };

        try {
            await untyped.create({
                data: { id: subject.userId, email: subject.email, not_a_users_column: 1 },
            });
        } catch (error) {
            return error;
        }

        throw new Error('the invalid users.create resolved, so there is no validation failure to report');
    };

    it('withholds a Prisma message instead of forwarding it, and says so', async () => {
        const error = await validationFailure(identity);

        // The premise: the raw message really does carry both values.
        expect((error as Error).message).toContain(identity.userId);
        expect((error as Error).message).toContain(identity.email);

        const fields = failureFields(error, identity, 'seed');
        const reported = fields.error as { name: string; message: string };

        expect(fields.code).toBe('prisma_validation_failed');
        expect(fields.userRef).toBe(userRef(identity.userId));
        expect(fields.phase).toBe('seed');

        // The class and the code travel; the vendor's sentence does not. No
        // fragment of it survives — `invocation` is the first word of every
        // Prisma validation message and `not_a_users_column` the argument it
        // rejected, so neither appearing is the whole claim.
        expect(reported.name).toBe('PrismaClientValidationError');
        expect(reported.message).toContain('withheld');
        expect(reported.message).not.toContain('invocation');
        expect(emitted(fields)).not.toContain('not_a_users_column');

        // And what replaces it keeps the operator able to act: this file's own
        // remedy for a client that disagrees with the migrated schema.
        expect(String(fields.remedy)).toContain('npx prisma migrate deploy');

        expect(emitted(fields)).toContain(userRef(identity.userId));
        expect(emitted(fields)).not.toContain(identity.userId);
        expect(emitted(fields)).not.toContain(identity.email);
    });

    it('withholds it however the identity is spelled inside it, quotes and control characters included', async () => {
        // The identity that defeats substitution. Each character is one Prisma
        // ESCAPES on the way into its message, so the value the message carries
        // is not the value `redactIdentity` holds a needle for: a literal
        // replacement of `…quote-"-tail` cannot match `…quote-\"-tail`. This is
        // reachable — the flag parser accepts any non-empty `--user-id`, and its
        // email pattern only forbids whitespace and a second `@`.
        const hostile: DevelopmentIdentity = {
            userId: 'seed-dev-hostile-quote-"-backslash-\\-control-\u0007-tail',
            email: 'seed-dev-hostile"quote\\backslash\u0007control@soh.invalid',
        };

        const error = await validationFailure(hostile);

        // The premise, and the mechanism of the defect this case exists for:
        // the message does NOT carry the raw values, it carries their escaped
        // representations. Asserting both halves is what stops the case passing
        // because Prisma stopped quoting arguments at all.
        expect((error as Error).message).not.toContain(hostile.userId);
        expect((error as Error).message).not.toContain(hostile.email);
        expect((error as Error).message).toContain(prismaEscaped(hostile.userId));
        expect((error as Error).message).toContain(prismaEscaped(hostile.email));

        // The FULLY EMITTED line, built the way `main`'s catch builds it and
        // serialized by the logger that writes it — sanitization, reserved-key
        // protection and all — rather than a proxy for it.
        const line = capturedFailureLine(error, hostile, 'seed');

        expect(line).toContain('"event":"stage_failed"');
        expect(line).toContain('"code":"prisma_validation_failed"');
        expect(line).toContain(userRef(hostile.userId));

        // Neither identifier, in any spelling that could be read back out of
        // it: raw, as Prisma escaped it, and as the line's own JSON encoding
        // would then render that.
        for (const value of [hostile.userId, hostile.email]) {
            for (const spelling of [value, prismaEscaped(value), prismaEscaped(prismaEscaped(value))]) {
                expect(line).not.toContain(spelling);
            }
        }
    });

    it('reports a duplicate email as its Prisma code and a remedy naming the flags, not the value', async () => {
        await prisma.users.create({ data: { id: 'seed-dev-test-existing-user', email: identity.email } });

        const error = await prisma.users
            .create({ data: { id: 'seed-dev-test-second-user', email: identity.email } })
            .then(
                () => null,
                (rejection: unknown) => rejection,
            );

        const fields = failureFields(error, identity);

        expect(fields.code).toBe('P2002');
        expect(fields.remedy).toBe(
            'Another row already holds that unique value. Pass a different --email, or --user-id to seed a different user.',
        );
        expect(emitted(fields)).not.toContain(identity.email);
    });

    it('forwards its OWN message, so withholding is about provenance and not about text', () => {
        // The other side of the rule, and the reason it is a rule about who
        // wrote the message rather than about how a message looks: this one was
        // composed in `seed-dev.ts` from the operator's `--date`, quotes no
        // invocation argument, and is the most useful thing the line can carry.
        const refusal = new SeedDevError('2026-02-30 is not a calendar date', 'invalid_date', '2026-02-30');
        const fields = failureFields(refusal, identity, 'startup');
        const reported = fields.error as { name: string; message: string };

        expect(fields.code).toBe('invalid_date');
        expect(reported.name).toBe('SeedDevError');
        expect(reported.message).toBe('2026-02-30 is not a calendar date');
        expect(emitted(fields)).toContain('2026-02-30');
        expectNothingIdentifying(fields, identity);
    });

    it('omits the fingerprint when the run failed before it resolved an identity', () => {
        // A `RangeError` is the RUNTIME's, not this file's — `Invalid time zone
        // specified: <value>` is V8 echoing an argument — so its message is
        // withheld like Prisma's, and it is withheld here even though there was
        // no identity to leak: the rule is decided by who composed the text,
        // never by whether this particular text happens to be harmless.
        const fields = failureFields(new RangeError('Invalid time value'), null);
        const reported = fields.error as { name: string; message: string };

        expect(fields.code).toBe('invalid_date');
        expect(fields.userRef).toBeUndefined();
        expect(fields.phase).toBeUndefined();
        expect(reported.name).toBe('RangeError');
        expect(reported.message).toContain('withheld');
        // Nothing would have been known to redact in any case, and
        // `redactIdentity` returns the text untouched rather than
        // half-redacted against a guess.
        expect(redactIdentity('Invalid time value', null)).toBe('Invalid time value');
    });

    it('reports a remedy of its own for a vendor code it does not map, rather than none', () => {
        // The mapped codes each carry a remedy composed here, but Prisma's code
        // space is open-ended and this stage cannot enumerate it. Withholding
        // the vendor's sentence removed the only text that used to tell an
        // operator what to do, so an unmapped code must still arrive with a
        // next step: a line carrying neither a message nor a remedy would be a
        // refusal that reports nothing actionable at all.
        const unmapped = new Prisma.PrismaClientKnownRequestError('Raw vendor text, not to be forwarded', {
            code: 'P9999',
            clientVersion: '6.9.0',
        });

        const fields = failureFields(unmapped, identity, 'seed');
        const reported = fields.error as { name: string; message: string };

        // The code still travels — it is an enumerated constant, not an echo of
        // the call's arguments — and it is what the operator looks up.
        expect(fields.code).toBe('P9999');
        expect(reported.message).toContain('withheld');
        expect(reported.message).not.toContain('Raw vendor text');
        expect(fields.remedy).toContain('No remedy is recorded for this code in this stage');
        expectNothingIdentifying(fields, identity);
    });

    it('redacts the longer value first, so an id contained in the address cannot survive it', () => {
        // `redactIdentity` is the SECOND line and not the guarantee — the
        // guarantee is the two cases above, which forward no message a vendor
        // composed. What is pinned here is that the second line is still
        // correct over the text it does run on, this stage's own messages:
        // `--user-id dev` with `--email dev@soh.invalid`, where replacing the
        // shorter needle first would rewrite the address into
        // "<ref>@soh.invalid" and leave the domain in the line.
        const overlapping: DevelopmentIdentity = { userId: 'dev', email: 'dev@soh.invalid' };

        const redacted = redactIdentity('upsert failed for id: "dev", email: "dev@soh.invalid"', overlapping);

        expect(redacted).not.toContain('dev@soh.invalid');
        expect(redacted).not.toContain('soh.invalid');
        expect(redacted).toContain('***');
        expect(redacted).toContain(userRef('dev'));
    });
});

/* ---------------------------------------------------------------------------
 * The per-user advisory lock, observed from a session that is not holding it
 * ------------------------------------------------------------------------- */

describe('the per-user advisory lock', () => {
    const identity = resolveIdentity(optionsOf([]));

    /** Holds the meal-planning lock for this user in a second session until released. */
    const holdUserLock = async (): Promise<{ release: () => void; held: Promise<unknown> }> => {
        const taken = deferred();
        const releaseSignal = deferred();

        const held = contendingClient.$transaction(
            async (tx) => {
                await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('meal-planning:' || ${identity.userId}))`;
                taken.release();
                await releaseSignal.promise;
            },
            { timeout: 20_000 },
        );

        await taken.promise;

        return { release: releaseSignal.release, held };
    };

    /**
     * Every advisory lock currently held or awaited on this user's key.
     *
     * `pg_advisory_xact_lock(hashtext(...))` takes the single-argument form, so
     * the 64-bit key is the sign-extended `int4` digest: its high half lands in
     * `classid` and its low half in `objid`, with `objsubid = 1`. Recomputing
     * both halves from `hashtext` in SQL is what makes this an assertion about
     * THAT key rather than about advisory locking in general.
     */
    const advisoryLocksOnUserKey = (): Promise<Array<{ granted: boolean }>> =>
        contendingClient.$queryRaw<Array<{ granted: boolean }>>`
            SELECT granted
            FROM pg_locks
            WHERE locktype = 'advisory'
              AND objsubid = 1
              AND classid::bigint = ((hashtext('meal-planning:' || ${identity.userId})::bigint >> 32) & 4294967295)
              AND objid::bigint = (hashtext('meal-planning:' || ${identity.userId})::bigint & 4294967295)
        `;

    /**
     * Waits until `pg_locks` shows the EXACT contention the case below is
     * about — one granted holder and one ungranted waiter on this user's key —
     * and returns those rows.
     *
     * POLLED RATHER THAN SAMPLED AFTER A PAUSE, and that is the whole
     * difference. "The seed has not finished yet" is a claim about elapsed
     * time, and a correct seed on a loaded database host can take longer than
     * any pause a test is willing to spend, so a pause makes the case fail
     * without a product regression. "An ungranted waiter exists on this key" is
     * a claim about the database's own lock table: it is true only while the
     * seed's transaction is genuinely blocked on that key, whatever the host is
     * doing, and it is what every assertion in the caller then rests on.
     *
     * Two things end the wait other than success, and both are real failures
     * rather than timeouts of an assertion:
     *
     *   * The seed SETTLED without ever appearing as a waiter. That is the
     *     regression this whole block exists to catch — a build that no longer
     *     takes `withUserLock` runs straight through the key another session
     *     holds — so it is reported immediately and by name instead of being
     *     left to exhaust the guard.
     *   * The guard expired. Nothing is asserted from that: it says the run is
     *     wedged, and the observed rows travel with the message so the next
     *     reader is not left guessing which half of the shape was missing.
     */
    const awaitContendedUserKey = async (seeding: {
        readonly settled: () => boolean;
    }): Promise<Array<{ granted: boolean }>> => {
        const deadline = Date.now() + WAITER_GUARD_MS;

        for (;;) {
            const contenders = await advisoryLocksOnUserKey();
            const granted = contenders.filter((row) => row.granted);
            const waiting = contenders.filter((row) => !row.granted);

            if (granted.length === 1 && waiting.length === 1) {
                return contenders;
            }

            if (seeding.settled()) {
                throw new Error(
                    'the seed settled without ever waiting on the per-user meal-planning key, so its ' +
                        'transaction did not take pg_advisory_xact_lock(hashtext(\'meal-planning:\' || userId)) ' +
                        `first; pg_locks showed ${JSON.stringify(contenders)}`,
                );
            }

            if (Date.now() >= deadline) {
                throw new Error(
                    `no granted holder and ungranted waiter appeared together on the per-user key within ` +
                        `${WAITER_GUARD_MS} ms; pg_locks showed ${JSON.stringify(contenders)}`,
                );
            }

            await sleep(LOCK_POLL_INTERVAL_MS);
        }
    };

    beforeEach(async () => {
        await truncateFeatureTables();
    }, BLOCK_TIMEOUT_MS);

    it(
        'makes the seed wait for the key another session holds, then lets it commit',
        async () => {
            const lock = await holdUserLock();
            // Started only after `holdUserLock` has returned, so the second
            // session provably holds the key first and the two contenders can
            // only be in one order.
            const seeding = watch(seed(identity));
            let bodyThrew = false;

            try {
                // It is waiting on THIS key: the holder granted and the seed
                // not, recomputed from `hashtext` rather than taken on trust.
                const contenders = await awaitContendedUserKey(seeding);

                expect(contenders).toHaveLength(2);
                expect(contenders.filter((row) => row.granted)).toHaveLength(1);
                expect(contenders.filter((row) => !row.granted)).toHaveLength(1);

                // And with that waiter observed, nothing of the seed is
                // visible — because the lock is taken before the transaction's
                // first statement, so the reset delete and every read below it
                // are still behind it. These are sound because the waiter's
                // EXISTENCE establishes the seed is blocked; they would not be
                // if "blocked" had been inferred from elapsed time.
                expect(seeding.settled()).toBe(false);
                expect(await prisma.users.count({ where: { id: identity.userId } })).toBe(0);
                expect(await prisma.meal_plan_preferences.count()).toBe(0);
                expect(await prisma.meals.count()).toBe(0);
            } catch (failure) {
                bodyThrew = true;
                throw failure;
            } finally {
                // EVERY path releases the holder, a failed assertion included.
                // Left held, its transaction would keep the key until the 20 s
                // timeout above and the cases below would queue behind it, so
                // one failure here would read as several.
                lock.release();

                const holderFailure = await lock.held.then(
                    () => null,
                    (error: unknown) => error,
                );

                if (bodyThrew) {
                    // Drained, not asserted on: this case has already failed
                    // with its own error, a failure raised while closing the
                    // holder is a consequence of that rather than the cause,
                    // and an unobserved rejection from the seed this case
                    // abandoned would otherwise surface against a later suite.
                    await seeding.done.then(
                        () => undefined,
                        () => undefined,
                    );
                } else if (holderFailure !== null) {
                    throw holderFailure;
                }
            }

            const summary = await seeding.done;

            expect(summary.changed).toBe(true);
            expect(await prisma.users.count({ where: { id: identity.userId } })).toBe(1);
        },
        LOCK_CASE_TIMEOUT_MS,
    );

    it(
        'does not make it wait when nothing holds the key',
        async () => {
            // The counter-proof. Without it the case above could pass because
            // of something incidental to the transaction, and a build that had
            // lost `withUserLock` would look exactly as correct.
            //
            // AWAITED OUTRIGHT rather than sampled after a pause: the claim is
            // that an uncontended seed completes, and the case's own timeout is
            // the only bound that has to hold for that. Requiring it to finish
            // inside some shorter window would be a claim about how fast the
            // database is, which is not a property of this stage.
            const summary = await seed(identity);

            expect(summary.changed).toBe(true);
            // It contended for nothing, so it left nothing on the key.
            expect(await advisoryLocksOnUserKey()).toEqual([]);
        },
        LOCK_CASE_TIMEOUT_MS,
    );

    it(
        'releases the key at COMMIT, so a second run is not blocked by the first',
        async () => {
            await seed(identity);

            // Transaction-scoped, so there is no unlock call to forget: the
            // first run's lock is gone the moment it committed.
            expect(await advisoryLocksOnUserKey()).toEqual([]);

            // Which the second run proves by completing at all: had the first
            // run's lock outlived its transaction, this one would block on it
            // until the case timeout.
            const rerun = await seed(identity, { now: RESEEDED_AT });

            expect(rerun.changed).toBe(false);
        },
        LOCK_CASE_TIMEOUT_MS,
    );

    it(
        'releases the key at ROLLBACK, so a seed that fails part-way cannot wedge the user',
        async () => {
            // A failure the seed really can hit, raised INSIDE the transaction
            // and after the lock: another row already holds the address, so
            // `users.upsert` raises P2002 on its create branch. A day key the
            // stage refuses would not do — that refusal happens before the
            // transaction opens, where no lock has been taken.
            await prisma.users.create({ data: { id: 'seed-dev-test-email-owner', email: identity.email } });

            const failure = await seed(identity).then(
                () => null,
                (error: unknown) => error,
            );

            expect(failure).toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
            expect((failure as Prisma.PrismaClientKnownRequestError).code).toBe('P2002');

            // The transaction rolled back, so it wrote nothing …
            expect(await prisma.users.count({ where: { id: identity.userId } })).toBe(0);
            expect(await prisma.meal_plan_preferences.count()).toBe(0);
            expect(await prisma.meals.count()).toBe(0);

            // … and the key is free again, because the lock went with it.
            expect(await advisoryLocksOnUserKey()).toEqual([]);

            // Which the next run proves by completing rather than waiting for
            // a key the rolled-back transaction would still be holding.
            await prisma.users.deleteMany({ where: { id: 'seed-dev-test-email-owner' } });

            const summary = await seed(identity);

            expect(summary.changed).toBe(true);
        },
        LOCK_CASE_TIMEOUT_MS,
    );
});

/* ---------------------------------------------------------------------------
 * The rows, and what a rerun does to them
 * ------------------------------------------------------------------------- */

describe('a first seed and its rerun', () => {
    const identity = resolveIdentity(optionsOf([]));
    let first: SeedSummary;
    let second: SeedSummary;

    beforeAll(async () => {
        await truncateFeatureTables();
        first = await seed(identity);
        second = await seed(identity, { now: RESEEDED_AT });
    }, BLOCK_TIMEOUT_MS);

    it('creates every object on the first run and changes nothing on the second', () => {
        expect(first.changed).toBe(true);
        expect(second).toEqual({
            userId: identity.userId,
            date: DAY_KEY,
            userReset: false,
            userOutcome: 'unchanged',
            preferencesOutcome: 'unchanged',
            mealsCreated: [],
            mealsExisting: [...DIARY_MEAL_NAMES],
            weighInOutcome: 'existing',
            changed: false,
        });
    });

    it('leaves one user row carrying the four declared target columns', async () => {
        const users = await prisma.users.findMany({
            select: {
                id: true,
                email: true,
                target_calories: true,
                target_protein_g: true,
                target_carbs_g: true,
                target_fat_g: true,
            },
        });

        expect(users).toEqual([
            {
                id: DEFAULT_DEV_USER_ID,
                email: DEFAULT_DEV_USER_EMAIL,
                target_calories: DEV_TARGETS.calories,
                target_protein_g: DEV_TARGETS.protein,
                target_carbs_g: DEV_TARGETS.carbs,
                target_fat_g: DEV_TARGETS.fat,
            },
        ]);
    });

    it('leaves one preferences row whose snapshot equals those columns, and is generatable', async () => {
        const preferences = await prisma.meal_plan_preferences.findUnique({
            where: { user_id: identity.userId },
        });

        expect(preferences).not.toBeNull();
        expect(preferences?.setup_status).toBe('completed');
        expect(preferences?.setup_step).toBe('review');
        expect(preferences?.target_source).toBe('estimated');
        // The pair the module header exists to explain: a snapshot that
        // disagreed with the columns above would make the canonical read report
        // `source: 'legacy'` and the planner answer `409 targets_unconfirmed`.
        expect(preferences?.confirmed_targets).toEqual({ ...DEV_TARGETS });
        expect(preferences?.revision).toBe(1);
        expect(preferences?.targets_revision).toBe(1);
        expect(preferences?.targets_input_revision).toBe(1);
    });

    it('leaves the four diary buckets for the seeded day, in render order, and no duplicates', async () => {
        const meals = await prisma.meals.findMany({
            where: { user_id: identity.userId },
            orderBy: { sort_order: 'asc' },
            select: { name: true, sort_order: true, date: true, deleted_at: true },
        });

        expect(meals).toEqual(
            DIARY_MEAL_NAMES.map((name, index) => ({
                name,
                sort_order: index,
                date: new Date(`${DAY_KEY}T00:00:00.000Z`),
                deleted_at: null,
            })),
        );
    });

    it('leaves exactly one weigh-in, stamped with the FIRST run\u2019s clock', async () => {
        const entries = await prisma.body_weight_entries.findMany({
            where: { user_id: identity.userId },
            select: { weight: true, logged_at: true },
        });

        // One row, and its timestamp proves the rerun did not write a second:
        // the second run's clock is RESEEDED_AT.
        expect(entries).toEqual([{ weight: DECLARED_WEIGH_IN_WEIGHT, logged_at: SEEDED_AT }]);
    });

    it('seeds no catalog, recipe, plan or food row', async () => {
        expect(await prisma.catalog_foods.count()).toBe(0);
        expect(await prisma.recipes.count()).toBe(0);
        expect(await prisma.meal_plans.count()).toBe(0);
        expect(await prisma.meal_entries.count()).toBe(0);
        // Deliberate: any row here would make `seedStarterFoodsIfEmpty`'s
        // count non-zero and suppress the starter library permanently.
        expect(await prisma.foods.count()).toBe(0);
    });
});

/* ---------------------------------------------------------------------------
 * --reset-user
 * ------------------------------------------------------------------------- */

describe('--reset-user', () => {
    const identity = resolveIdentity(optionsOf([]));
    let reset: SeedSummary;

    beforeAll(async () => {
        await truncateFeatureTables();
        await seed(identity);

        // Two rows the reset must take with it: a bucket the developer renamed
        // and a second weigh-in. Both hang off the user, so the cascade is what
        // removes them.
        await prisma.meals.create({
            data: {
                user_id: identity.userId,
                date: new Date(`${DAY_KEY}T00:00:00.000Z`),
                name: 'Midnight snack',
                sort_order: 9,
            },
        });
        await prisma.body_weight_entries.create({
            data: { user_id: identity.userId, weight: 176.4, logged_at: RESEEDED_AT },
        });

        reset = await seed(identity, { now: RESEEDED_AT, resetUser: true });
    }, BLOCK_TIMEOUT_MS);

    it('reports the reset and a full reseed', () => {
        expect(reset).toEqual({
            userId: identity.userId,
            date: DAY_KEY,
            userReset: true,
            userOutcome: 'created',
            preferencesOutcome: 'created',
            mealsCreated: [...DIARY_MEAL_NAMES],
            mealsExisting: [],
            weighInOutcome: 'created',
            changed: true,
        });
    });

    it('leaves the declared state and nothing the previous user had accumulated', async () => {
        const meals = await prisma.meals.findMany({
            where: { user_id: identity.userId },
            orderBy: { sort_order: 'asc' },
            select: { name: true, sort_order: true },
        });
        const entries = await prisma.body_weight_entries.findMany({
            where: { user_id: identity.userId },
            select: { weight: true, logged_at: true },
        });

        expect(meals).toEqual(DIARY_MEAL_NAMES.map((name, index) => ({ name, sort_order: index })));
        expect(entries).toEqual([{ weight: DECLARED_WEIGH_IN_WEIGHT, logged_at: RESEEDED_AT }]);
        expect(await prisma.users.count()).toBe(1);
        expect(await prisma.meal_plan_preferences.count()).toBe(1);
    });

    it('reports the reset without naming the user it reset', () => {
        const fields = completionFields(reset);

        expect(fields.userReset).toBe(true);
        expectNothingIdentifying(fields, identity);
    });
});

/* ---------------------------------------------------------------------------
 * What it refuses before it writes
 * ------------------------------------------------------------------------- */

describe('what it refuses', () => {
    beforeAll(async () => {
        await truncateFeatureTables();
    }, BLOCK_TIMEOUT_MS);

    it('accepts a real calendar day and refuses one that would roll forward', () => {
        expect(parseDayKey(DAY_KEY)).toEqual(new Date(`${DAY_KEY}T00:00:00.000Z`));
        expect(parseDayKey('2026-02-30')).toBeNull();
        expect(parseDayKey('2026-9-20')).toBeNull();
    });

    it('rejects --confirm-target rather than ignoring it', () => {
        const parsed = parseArgs(['--confirm-target', 'soh_dev']);

        expect(parsed.ok).toBe(false);
        expect(parsed.ok ? [] : parsed.errors.map((failure) => failure.flag)).toEqual(['--confirm-target']);
    });

    it('names a repeated flag without echoing the value it was given', () => {
        const parsed = parseArgs(['--email', 'first@soh.invalid', '--email', 'second@soh.invalid']);

        expect(parsed.ok).toBe(false);
        const problems = parsed.ok ? [] : parsed.errors.map((failure) => failure.message);
        expect(problems).toHaveLength(1);
        expect(problems[0]).not.toContain('second@soh.invalid');
    });

    it('refuses an impossible day before opening a transaction, so nothing is written', async () => {
        const identity = resolveIdentity(optionsOf([]));

        const failure = await runSeed({
            client: prisma,
            now: () => SEEDED_AT,
            identity,
            dayKey: '2026-02-30',
        }).then(
            () => null,
            (error: unknown) => error,
        );

        expect(failure).toBeInstanceOf(SeedDevError);
        expect((failure as SeedDevError).code).toBe('invalid_date');
        expect((failure as SeedDevError).value).toBe('2026-02-30');
        expect(await prisma.users.count()).toBe(0);
    });
});
