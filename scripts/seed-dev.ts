// The development seed: the one command in scripts/ that acts.
//
// It gives a developer machine the minimum a meal-planning session needs: a
// user row to own everything else, its meal-planning preferences row in the
// pre-setup state, and the four diary buckets for one day. Everything it needs
// is already in this repository — Prisma and the migrated schema — so unlike
// the catalog stages this file is implemented end to end and returns 0.
//
// IT IS IDEMPOTENT, and that is the property worth stating. A second run
// creates nothing and changes nothing: the user is upserted by its id, the
// preferences row by its unique `user_id`, and each diary bucket only when the
// day has no live row of that name. Both runs report the same counts, split
// into created and existing, so an operator can see which it was.
//
// WHAT IT DELIBERATELY DOES NOT DO. The preferences row is created with
// `setup_status: 'not_started'` and `revision: 0` and nothing else, because
// anything further would be fabricated onboarding progress — and an existing
// row is left exactly as it is, so a developer part-way through setup does not
// lose it to a reseed. Soft-deleted diary rows are ignored rather than revived:
// `meals.deleted_at` is how the app records a meal the user removed, and
// resurrecting one would rewrite their history.
//
// ITS DATABASE IS DEVELOPMENT ONLY. `seed-dev` is `development_only` in
// scripts/lib/dbGuard.ts, which refuses a test, shadow or unrecognised origin
// at module load with no confirmation flag available — it is the one script
// here that writes user-scoped rows, which is exactly what Rule
// backend-architecture §5.1 protects.
//
// The two guard imports are ordered and load-bearing. Rule
// backend-architecture §10 requires the IPv4-first DNS ordering before any
// network module loads, and the guard must classify DATABASE_URL before Prisma
// exists: TypeScript's CommonJS emit hoists requires in source order, and
// ../src/prisma/client constructs the client at import time, so the two guards
// standing above it is what puts the refusal ahead of the connection.
import './lib/bootstrap';
import './lib/dbGuard';

import { classifyDatabaseOrigin, DatabaseOriginError } from './lib/dbGuard';
import { createFatalLogger, createLogger, safeError, writeLineSync } from './lib/logger';
import type { LogFields, LogLevel } from './lib/logger';
import { prisma } from '../src/prisma/client';
import { Prisma } from '../src/generated/prisma';

const STAGE = 'seed-dev';

/**
 * The default identity, deliberately fixed: `users.id` carries no database
 * default (it holds a Firebase uid in production), so the seed has to supply
 * one, and a stable value is what makes a rerun a no-op instead of a second
 * user. `.invalid` is the RFC 2606 reserved TLD, so the address can never
 * belong to a real mailbox.
 */
export const DEFAULT_DEV_USER_ID = 'dev-seed-user';
export const DEFAULT_DEV_USER_EMAIL = 'dev-seed-user@soh.invalid';

/**
 * The diary buckets one day needs, in the order the app renders them. The
 * `sort_order` is the index, so a seeded day sorts the same way a day the app
 * created lazily does.
 */
export const DIARY_MEAL_NAMES: readonly string[] = ['Breakfast', 'Lunch', 'Dinner', 'Snack'];

/** The pre-setup state of the meal-planning state machine (prisma/schema.prisma). */
const SETUP_STATUS_NOT_STARTED = 'not_started';

const REQUIRED_TABLES: readonly string[] = ['users', 'meal_plan_preferences', 'meals'];

const DAY_KEY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

const logger = createLogger(STAGE);

// ---------------------------------------------------------------------------
// Argument parsing — pure (Rule backend-architecture §1.2): no `process`, no
// clock, no I/O, so every branch is decided from the argv it is handed. The
// default date is resolved by the caller, not here.
// ---------------------------------------------------------------------------

export interface SeedOptions {
    readonly help: boolean;
    readonly email: string | null;
    readonly userId: string | null;
    /** `--date`; `null` means "today", resolved by `todayDayKey` in main. */
    readonly date: string | null;
}

export interface ArgumentError {
    readonly flag: string;
    readonly message: string;
}

export type ParseResult =
    | { readonly ok: true; readonly options: SeedOptions }
    | { readonly ok: false; readonly errors: readonly ArgumentError[] };

export interface PrerequisiteGap {
    readonly code: string;
    readonly requirement: string;
    readonly remedy: string;
    readonly detail?: string;
}

const HELP_FLAGS: readonly string[] = ['--help', '-h'];

// dbGuard's flag. It has no effect for this script — `development_only` offers
// no confirmation door — but it is consumed rather than rejected so an operator
// who passes it to every stage gets this stage's usage, and the guard's own
// refusal message is what explains that the door does not exist here.
const CONFIRM_TARGET_FLAG = '--confirm-target';

interface Token {
    readonly flag: string;
    readonly inlineValue: string | null;
}

const splitToken = (token: string): Token => {
    const separator = token.indexOf('=');
    if (!token.startsWith('--') || separator < 0) {
        return { flag: token, inlineValue: null };
    }
    return { flag: token.slice(0, separator), inlineValue: token.slice(separator + 1) };
};

/**
 * A real calendar day, not merely four-two-two digits: `Date.UTC` rolls
 * 2026-02-30 forward to March, so the parsed value is compared back against
 * the input and a rolled date is refused. UTC throughout, because the column
 * is a bare `date` and a local-midnight value would land on the previous day
 * for any negative offset.
 */
export const parseDayKey = (value: string): Date | null => {
    if (!DAY_KEY_PATTERN.test(value)) {
        return null;
    }

    const year = Number(value.slice(0, 4));
    const month = Number(value.slice(5, 7));
    const day = Number(value.slice(8, 10));
    if (month < 1 || month > 12 || day < 1 || day > 31) {
        return null;
    }

    const parsed = new Date(Date.UTC(year, month - 1, day));
    const rolled =
        parsed.getUTCFullYear() !== year || parsed.getUTCMonth() !== month - 1 || parsed.getUTCDate() !== day;
    return rolled ? null : parsed;
};

export const parseArgs = (argv: readonly string[]): ParseResult => {
    if (argv.some((token) => HELP_FLAGS.includes(token))) {
        return { ok: true, options: { help: true, email: null, userId: null, date: null } };
    }

    const errors: ArgumentError[] = [];
    let email: string | null = null;
    let emailSeen = false;
    let userId: string | null = null;
    let userIdSeen = false;
    let date: string | null = null;
    let dateSeen = false;

    let index = 0;
    const takeValue = (inlineValue: string | null): string | null => {
        if (inlineValue !== null) {
            return inlineValue.length > 0 ? inlineValue : null;
        }
        const next = index < argv.length ? argv[index] : null;
        if (next === null || next.length === 0 || next.startsWith('-')) {
            return null;
        }
        index += 1;
        return next;
    };

    while (index < argv.length) {
        const { flag, inlineValue } = splitToken(argv[index]);
        index += 1;

        if (flag === '--email') {
            const value = takeValue(inlineValue);
            if (value === null) {
                errors.push({ flag, message: `${flag} requires an email address` });
                continue;
            }
            if (emailSeen) {
                errors.push({ flag, message: `${flag} was given more than once; it takes a single value` });
                continue;
            }
            emailSeen = true;
            // One local part, one "@", one domain with a dot: enough to catch a
            // mistyped flag without pretending to implement RFC 5322 for a
            // development seed. `users.email` is unique, never delivered to.
            if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
                errors.push({ flag, message: `${flag} must be an email address, for example dev@soh.invalid` });
                continue;
            }
            email = value;
            continue;
        }

        if (flag === '--user-id') {
            const value = takeValue(inlineValue);
            if (value === null) {
                errors.push({ flag, message: `${flag} requires a user id` });
                continue;
            }
            if (userIdSeen) {
                errors.push({ flag, message: `${flag} was given more than once; it takes a single value` });
                continue;
            }
            userIdSeen = true;
            userId = value;
            continue;
        }

        if (flag === '--date') {
            const value = takeValue(inlineValue);
            if (value === null) {
                errors.push({ flag, message: `${flag} requires a date as YYYY-MM-DD` });
                continue;
            }
            if (dateSeen) {
                errors.push({ flag, message: `${flag} was given more than once; it takes a single value` });
                continue;
            }
            dateSeen = true;
            if (parseDayKey(value) === null) {
                errors.push({ flag, message: `${flag} must be a real calendar date as YYYY-MM-DD` });
                continue;
            }
            date = value;
            continue;
        }

        if (flag === CONFIRM_TARGET_FLAG) {
            takeValue(inlineValue);
            continue;
        }

        errors.push({ flag, message: `${flag} is not a flag ${STAGE} accepts` });
    }

    if (errors.length > 0) {
        return { ok: false, errors };
    }

    return { ok: true, options: { help: false, email, userId, date } };
};

// ---------------------------------------------------------------------------
// Usage.
// ---------------------------------------------------------------------------

export const describeUsage = (): string =>
    [
        `Usage: npm run db:seed:dev -- [options]   (${STAGE})`,
        '',
        'Seeds a development database with one user, its meal-planning preferences',
        'row in the not_started state, and the four diary buckets for one day.',
        'Idempotent: a second run with the same flags creates nothing and changes',
        'nothing, and reports the same counts.',
        '',
        'Options:',
        '  --email <addr>       Email for the seeded user. Must be unique in the',
        `                       database. Default: ${DEFAULT_DEV_USER_EMAIL}`,
        '  --user-id <id>       Id for the seeded user; users.id has no database',
        '                       default, so a fixed value is what makes a rerun a',
        `                       no-op. Default: ${DEFAULT_DEV_USER_ID}`,
        '  --date <YYYY-MM-DD>  The day the diary buckets are created for, as a real',
        '                       calendar date. Default: today (UTC).',
        '  --help, -h           Print this usage block and exit 0.',
        '',
        'What it writes:',
        '  users                  one row, upserted by id',
        '  meal_plan_preferences  one row, upserted by user_id, setup_status',
        '                         not_started and revision 0; an existing row is left',
        '                         untouched so in-progress setup survives a reseed',
        `  meals                  ${DIARY_MEAL_NAMES.join(', ')} for the target date,`,
        '                         sort_order 0-3, created only where the day has no',
        '                         live row of that name (soft-deleted rows ignored)',
        '',
        'Environment:',
        '  DATABASE_URL   required, and must be a development origin: this script is',
        '                 development_only in scripts/lib/dbGuard.ts, so a test,',
        '                 shadow or unrecognised database is refused and there is no',
        '                 confirmation flag that overrides it.',
    ].join('\n');

const writeUsage = (level: LogLevel): void => {
    writeLineSync(describeUsage(), level);
};

/** Today as the `date` column spells it. UTC, for the reason in `parseDayKey`. */
export const todayDayKey = (now: Date = new Date()): string => now.toISOString().slice(0, 10);

// ---------------------------------------------------------------------------
// Preflight.
//
// The stage's inputs are Prisma and the migrated schema, and only the second
// can be missing in a way worth reporting: without the generated client this
// file cannot even load, and with it, the one remaining operator mistake is a
// database that has not had `prisma migrate deploy` run against it. Catching
// that here turns a mid-transaction P2021 into a named refusal with its remedy,
// before anything is written.
// ---------------------------------------------------------------------------

export interface SeedPreflightDeps {
    /** Which of REQUIRED_TABLES exist in the target database's public schema. */
    readonly listExistingTables: () => Promise<readonly string[]>;
}

const listExistingTables = async (): Promise<readonly string[]> => {
    // Static SQL — the table names are constants in the template, not
    // interpolated values — and a read of information_schema only.
    const rows = await prisma.$queryRaw<Array<{ table_name: string }>>`
        SELECT table_name
        FROM information_schema.tables
        WHERE table_schema = 'public'
          AND table_name IN ('users', 'meal_plan_preferences', 'meals')
    `;
    return rows.map((row) => row.table_name);
};

const defaultPreflightDeps = (): SeedPreflightDeps => ({ listExistingTables });

export const preflight = async (deps: SeedPreflightDeps): Promise<readonly PrerequisiteGap[]> => {
    const present = await deps.listExistingTables();
    const missing = REQUIRED_TABLES.filter((table) => !present.includes(table));

    if (missing.length === 0) {
        return [];
    }

    return [
        {
            code: 'schema_not_migrated',
            requirement: `The target database must carry the application schema; ${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} absent`,
            remedy: 'Run "npx prisma migrate deploy" against this DATABASE_URL, then seed again.',
        },
    ];
};

// ---------------------------------------------------------------------------
// The seed.
// ---------------------------------------------------------------------------

/** What one run did, per object, so created and existing are never conflated. */
export interface SeedSummary {
    readonly userId: string;
    readonly email: string;
    readonly date: string;
    readonly userOutcome: 'created' | 'existing' | 'email_updated';
    readonly preferencesOutcome: 'created' | 'existing';
    readonly mealsCreated: readonly string[];
    readonly mealsExisting: readonly string[];
}

interface SeedRequest {
    readonly userId: string;
    readonly email: string;
    readonly dayKey: string;
}

/**
 * Everything in one interactive transaction, so a run either leaves a complete
 * development day or leaves the database exactly as it was — a user with no
 * preferences row, or a day with two of its four buckets, is a state the app
 * would then have to interpret.
 */
const seed = async (request: SeedRequest): Promise<SeedSummary> => {
    const date = parseDayKey(request.dayKey);
    if (date === null) {
        // Unreachable through main, which parses the flag and defaults from
        // `todayDayKey`; kept because this function is exported behaviour and a
        // silent `new Date(undefined)` would write an invalid date.
        throw new RangeError(`${request.dayKey} is not a calendar date as YYYY-MM-DD`);
    }

    return prisma.$transaction(async (tx) => {
        const existingUser = await tx.users.findUnique({
            where: { id: request.userId },
            select: { id: true, email: true },
        });

        // Upsert rather than create-if-absent so a run that changes --email
        // moves the existing development row instead of failing; the outcome
        // distinguishes the three cases for the log.
        await tx.users.upsert({
            where: { id: request.userId },
            create: { id: request.userId, email: request.email },
            update: { email: request.email },
        });

        const userOutcome: SeedSummary['userOutcome'] =
            existingUser === null ? 'created' : existingUser.email === request.email ? 'existing' : 'email_updated';

        const existingPreferences = await tx.meal_plan_preferences.findUnique({
            where: { user_id: request.userId },
            select: { id: true },
        });

        // `update: {}` is the decision, not an omission: a developer part-way
        // through setup keeps their progress across a reseed. Only the create
        // branch states the pre-setup values.
        await tx.meal_plan_preferences.upsert({
            where: { user_id: request.userId },
            create: { user_id: request.userId, setup_status: SETUP_STATUS_NOT_STARTED, revision: 0 },
            update: {},
        });

        const preferencesOutcome: SeedSummary['preferencesOutcome'] =
            existingPreferences === null ? 'created' : 'existing';

        const mealsCreated: string[] = [];
        const mealsExisting: string[] = [];

        // `meals` has no unique constraint over (user_id, date, name) — the app
        // lets a user add and rename meals freely — so this is a scoped lookup
        // and a conditional insert rather than an upsert. Every predicate
        // carries `user_id` (§5.1) and `deleted_at: null`, so a bucket the user
        // deleted stays deleted and is recreated as a new row instead of being
        // revived.
        for (let index = 0; index < DIARY_MEAL_NAMES.length; index += 1) {
            const name = DIARY_MEAL_NAMES[index];
            const existingMeal = await tx.meals.findFirst({
                where: { user_id: request.userId, date, name, deleted_at: null },
                select: { id: true },
            });

            if (existingMeal !== null) {
                mealsExisting.push(name);
                continue;
            }

            await tx.meals.create({
                data: { user_id: request.userId, date, name, sort_order: index },
            });
            mealsCreated.push(name);
        }

        return {
            userId: request.userId,
            email: request.email,
            date: request.dayKey,
            userOutcome,
            preferencesOutcome,
            mealsCreated,
            mealsExisting,
        };
    });
};

// ---------------------------------------------------------------------------
// Reporting.
// ---------------------------------------------------------------------------

const gapFields = (gaps: readonly PrerequisiteGap[]): LogFields => {
    const fields: LogFields = { stage: STAGE, gapCount: gaps.length };
    for (const gap of gaps) {
        fields[`gap_${gap.code}`] =
            gap.detail === undefined
                ? `${gap.requirement}. ${gap.remedy}`
                : `${gap.requirement}. ${gap.remedy} [${gap.detail}]`;
    }
    return fields;
};

/**
 * Every error class this stage can observe gets its own reported code.
 *
 * The catalog error vocabulary (ManifestError, ModelBudgetError,
 * RateLimitConfigError, CheckpointError) is deliberately absent: this file
 * imports none of manifest, budget, rateLimiter or checkpoint, so none of those
 * can arise here, and importing a module only to narrow an impossible branch
 * would load the catalog ledger into a development seeder. What can arise is
 * Prisma's own failures, and those are what is narrowed — a known request error
 * keeps its `P####` code, which is the code an operator searches for, and
 * `unexpected_error` remains the honest answer for anything unrecognised.
 */
const describeFailure = (error: unknown): { code: string; error: { name: string; message: string } } => {
    if (error instanceof DatabaseOriginError) {
        return { code: error.code, error: safeError(error) };
    }
    if (error instanceof Prisma.PrismaClientKnownRequestError) {
        return { code: error.code, error: safeError(error) };
    }
    if (error instanceof Prisma.PrismaClientInitializationError) {
        return { code: 'prisma_initialization_failed', error: safeError(error) };
    }
    if (error instanceof Prisma.PrismaClientValidationError) {
        return { code: 'prisma_validation_failed', error: safeError(error) };
    }
    if (error instanceof RangeError) {
        return { code: 'invalid_date', error: safeError(error) };
    }
    return { code: 'unexpected_error', error: safeError(error) };
};

/**
 * The two Prisma failures an operator will actually hit here, given their own
 * remedy on top of the code: a database the migration has not reached, and an
 * email already held by another user row.
 */
const PRISMA_REMEDIES: Readonly<Record<string, string>> = {
    P2021: 'The table does not exist in this database. Run "npx prisma migrate deploy" against this DATABASE_URL.',
    P2002: 'Another row already holds that unique value. Pass a different --email, or --user-id to seed a different user.',
    P1001: 'The database could not be reached. Check that it is running and that DATABASE_URL names the right host and port.',
};

const main = async (): Promise<number> => {
    const parsed = parseArgs(process.argv.slice(2));

    if (!parsed.ok) {
        for (const failure of parsed.errors) {
            logger.error('argument_rejected', { stage: STAGE, flag: failure.flag, problem: failure.message });
        }
        writeUsage('error');
        return 1;
    }

    if (parsed.options.help) {
        writeUsage('info');
        return 0;
    }

    const origin = classifyDatabaseOrigin(process.env.DATABASE_URL);
    logger.info('database_origin_accepted', {
        stage: STAGE,
        originClass: origin.originClass,
        host: origin.host,
        database: origin.database,
        reason: origin.reason,
    });

    const request: SeedRequest = {
        userId: parsed.options.userId === null ? DEFAULT_DEV_USER_ID : parsed.options.userId,
        email: parsed.options.email === null ? DEFAULT_DEV_USER_EMAIL : parsed.options.email,
        dayKey: parsed.options.date === null ? todayDayKey() : parsed.options.date,
    };
    logger.info('stage_invoked', {
        stage: STAGE,
        userId: request.userId,
        email: request.email,
        date: request.dayKey,
    });

    // `finally` rather than a trailing call: the client holds a connection pool,
    // and a refusal or a failed transaction must release it just as a success
    // does, or the process hangs on an open handle.
    try {
        const gaps = await preflight(defaultPreflightDeps());
        if (gaps.length > 0) {
            logger.error('stage_prerequisites_unmet', gapFields(gaps));
            return 1;
        }

        const summary = await seed(request);
        logger.info('seed_complete', {
            stage: STAGE,
            userId: summary.userId,
            email: summary.email,
            date: summary.date,
            users: summary.userOutcome,
            mealPlanPreferences: summary.preferencesOutcome,
            mealsCreated: summary.mealsCreated,
            mealsExisting: summary.mealsExisting,
            mealsCreatedCount: summary.mealsCreated.length,
            mealsExistingCount: summary.mealsExisting.length,
        });
        return 0;
    } finally {
        await prisma.$disconnect();
    }
};

// Guarded so importing this module for parseArgs, preflight, parseDayKey or
// describeUsage never seeds a database.
if (require.main === module) {
    main()
        .then((exitCode) => {
            process.exit(exitCode);
        })
        .catch((error: unknown) => {
            const failure = describeFailure(error);
            const remedy = Object.prototype.hasOwnProperty.call(PRISMA_REMEDIES, failure.code)
                ? PRISMA_REMEDIES[failure.code]
                : undefined;
            createFatalLogger(STAGE).error('stage_failed', {
                stage: STAGE,
                code: failure.code,
                remedy,
                error: failure.error,
            });
            process.exit(1);
        });
}
