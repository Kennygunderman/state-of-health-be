// The development seed: the one command in scripts/ that acts.
//
// It gives a developer machine the state a meal-planning session needs and
// nothing else: a user row to own everything, that user's meal-planning
// preferences ANSWERED AND COMPLETE, confirmed nutrition targets, and the four
// diary buckets for one day. That is the whole point — reaching the Meal Plan
// screens otherwise means hand-driving the seven-step wizard on every fresh
// database, and a developer who does that fifty times learns nothing the
// fiftieth time. Everything it needs is already in this repository — Prisma and
// the migrated schema — so unlike the catalog stages this file is implemented
// end to end and returns 0.
//
// IT HOLDS NO BUSINESS RULE (Rule backend-architecture §1.2/§7/§7.1). It
// computes no target, derives no plan and aggregates no grocery list. Every
// derived-looking number below is a plainly labelled development CONSTANT, and
// the constants are grouped in one block so there is no arithmetic anywhere in
// this file to get wrong. §7.1's anti-ceremony rule is why there is no
// seed-dev.logic.ts beside it: a rule worth pinning in a test is a rule this
// file does not own.
//
// IT IS IDEMPOTENT, and that is the property worth stating. A second run
// changes nothing: the user is upserted by its id, the preferences row by its
// unique `user_id`, each diary bucket only when the day has no live row of that
// name, and the weigh-in only when the user has none. Each object reports
// created, updated or unchanged against the state read at the start of the same
// transaction, so a rerun says `unchanged` everywhere and an operator can see
// which it was rather than taking the word "idempotent" on trust.
//
// IT CONVERGES THE IDENTITY IT OWNS. The preferences row and the four target
// columns are written to the declared development state on every run, not only
// when absent. A seeder that skipped an existing row could not promise the one
// thing it exists to promise — that this user can generate a week — because a
// row left half-answered fails `POST /api/meal-planning/plans` with
// `409 preferences_incomplete`. The summary names every row it rewrote, which
// matters because `--user-id` can name a real Firebase uid, and `--reset-user`
// is the way back to an empty slate.
//
// WHY THE TARGETS ARE WRITTEN ON BOTH SIDES, TOGETHER, IN ONE TRANSACTION.
// `users.target_*` holds the values; `meal_plan_preferences.confirmed_targets`
// holds the snapshot of what was confirmed. src/services/targets.logic.ts
// compares the two field for field and reports `source: 'legacy'` the moment
// they disagree — that comparison is how the read stays truthful about the
// untouched `PUT /api/user/targets`, which can move the columns without leaving
// any other trace. A seed that wrote one side would therefore make every
// development run look like a legacy account, and the planner answers
// `409 targets_unconfirmed` for exactly that verdict. The snapshot is spelled
// with the WIRE names (`calories`, `protein`, `carbs`, `fat`), not the column
// names, because those are the keys that comparison reads.
//
// WHAT IT DELIBERATELY DOES NOT SEED:
//   * No `catalog_foods`, `catalog_food_aliases`, `catalog_food_portions`,
//     `catalog_food_components` or `catalog_validation_records`, and no
//     `recipes`, `recipe_versions` or `recipe_ingredients`. Those are shared
//     reference data with a reviewed, checksummed provenance, and
//     `catalog-load` and `recipes-seed` are the only sanctioned ways to install
//     them.
//   * No `meal_plans`, `meal_plan_days`, `meal_plan_meals`, `grocery_items` or
//     `meal_plan_actions`. A development plan is produced by calling
//     `POST /api/meal-planning/plans` from the app, so the deterministic
//     generator, its idempotency ledger and its grocery aggregation are always
//     the code under test rather than a fixture standing in for them.
//     Hand-writing a week here would let a broken generator look healthy, which
//     is the one outcome a development seed must not buy.
//   * No `foods`. Not an omission and not laziness: `getFoodsForUser` already
//     calls `seedStarterFoodsIfEmpty`, which inserts the starter library on
//     first read and is gated on `count({where: {user_id}}) > 0` with no
//     `deleted_at` filter (src/services/food.service.ts:41-49). Pre-inserting
//     any row here would make that count non-zero and SUPPRESS the starter
//     library permanently, so seeding foods would leave the Add Food screen
//     worse than seeding nothing does.
//
// ITS DATABASE IS DEVELOPMENT ONLY, AND THERE IS NO DOOR. `seed-dev` is
// `development_only` in scripts/lib/dbGuard.ts, which refuses a test, shadow or
// unrecognised origin at module load. `--confirm-target` is deliberately absent:
// that flag belongs to `catalog-load` and `recipes-seed`, which write SHARED
// REFERENCE data and can be asked to populate a shared environment once a human
// types the database name. This script writes USER-SCOPED rows, which is
// precisely what Rule backend-architecture §5.1 protects, so it is offered no
// equivalent — passing the flag here is rejected rather than ignored, so nobody
// is left believing it opened something. Every predicate below carries
// `user_id`, reads and writes alike, for the same reason.
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
import type { PrismaClient } from '../src/generated/prisma';

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

const REQUIRED_TABLES: readonly string[] = ['users', 'meal_plan_preferences', 'meals', 'body_weight_entries'];

const DAY_KEY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

const logger = createLogger(STAGE);

/**
 * A failure this stage raises itself, as opposed to one it observes from Prisma
 * or the database guard.
 *
 * Rule backend-architecture §8: a failure the caller must distinguish carries
 * the data rather than a string, and sets `this.name` so a report names the
 * class rather than a bare `Error`. It follows `DatabaseOriginError` and
 * `entitlement.service.ts`'s `DailyQuotaError` in carrying a machine-readable
 * `code` beside the message, which is what `describeFailure` reports and
 * `main` maps to a non-zero exit. It is never caught to be swallowed.
 */
export class SeedDevError extends Error {
    constructor(
        message: string,
        public readonly code: 'invalid_date',
        /** The value that was rejected, so the report names it rather than hinting at it. */
        public readonly value: string,
    ) {
        super(message);
        this.name = 'SeedDevError';
    }
}

// ---------------------------------------------------------------------------
// THE DEVELOPMENT ANSWERS.
//
// One block, and the only place a number in this file comes from. Nothing below
// is calculated: Rule backend-architecture §1.2/§7 puts business rules in pure
// `*.logic.ts` modules under test, and a seeder that re-derived a target would
// be a second implementation of the energy equation that could disagree with
// the first — the failure mode §7's whole "one rule, one place" instinct exists
// to prevent. These are CONSTANTS, labelled as such, and a developer who wants
// different ones edits this block.
// ---------------------------------------------------------------------------

/** The four target values, spelled the way the canonical read compares them. */
export interface DevelopmentTargets {
    readonly calories: number;
    readonly protein: number;
    readonly carbs: number;
    readonly fat: number;
}

/**
 * The confirmed development targets.
 *
 * These four numbers are Agent Action Plan §0.9.3's own worked example of the
 * target estimate, for exactly the body answers in {@link DEV_PREFERENCE_ANSWERS}
 * below — female, 34 years, 177.8 cm, 82.6 kg, lightly active, losing 1 lb a
 * week, which that section records as BMR 1,606 → TDEE 2,209 → 1,709 kcal with a
 * 30/30/40 split of 128 g protein, 171 g carbs, 57 g fat. Taking the documented
 * figure rather than computing one is what lets `target_source: 'estimated'`
 * below be TRUE — the row claims the estimated route, and the numbers really are
 * that route's answer for these answers — while this file still performs no
 * arithmetic. Change a body answer without changing these and the pairing stops
 * being honest, which is why they sit in the same block.
 */
export const DEV_TARGETS: DevelopmentTargets = {
    calories: 1709,
    protein: 128,
    carbs: 171,
    fat: 57,
};

/**
 * The same four numbers as `users` columns, derived from {@link DEV_TARGETS} so
 * the two spellings cannot drift. The column names and the wire names differ
 * (`target_protein_g` against `protein`), and that difference is exactly what
 * `targets.logic.ts` compares across, so writing either by hand twice is how a
 * seed comes to report `legacy`.
 */
const developmentUserTargetColumns = (): {
    target_calories: number;
    target_protein_g: number;
    target_carbs_g: number;
    target_fat_g: number;
} => ({
    target_calories: DEV_TARGETS.calories,
    target_protein_g: DEV_TARGETS.protein,
    target_carbs_g: DEV_TARGETS.carbs,
    target_fat_g: DEV_TARGETS.fat,
});

/** One saved meal time, in the shape `meal_plan_preferences.meal_times` stores. */
interface DevelopmentMealTime {
    readonly slot: string;
    readonly time: string;
}

/**
 * The three meal times, as 24-hour `HH:mm` — the format
 * `preferences.logic.ts::isClockTime` accepts and the generator reads per slot.
 * 08:00, 12:30 and 18:30 are the product defaults Agent Action Plan §0.7.4
 * seeds the schedule pills with, which is why a seeded row may hold them: they
 * are defaults the product owns, not a user's answer this script invented.
 */
const DEV_MEAL_TIMES: readonly DevelopmentMealTime[] = [
    { slot: 'breakfast', time: '08:00' },
    { slot: 'lunch', time: '12:30' },
    { slot: 'dinner', time: '18:30' },
];

/**
 * The stored weigh-in, and the one number here that is NOT metric.
 *
 * `body_weight_entries.weight` carries no unit column and the app never
 * converts it — it stores what the user typed and displays it under whatever
 * unit they currently prefer. The development answers set `weight_unit_pref:
 * 'lb'`, so the honest value to store is the pounds reading, 182.2 lb, which is
 * the same body as the metric `weight_kg: 82.6` the preferences row holds
 * (182.2 lb = 82.64 kg). It also lands inside the supported 66-661 lb
 * body-weight range, which is what makes the About-you screen offer it as a
 * prefill rather than starting empty.
 */
const DEV_WEIGH_IN_WEIGHT_AS_TYPED = 182.2;

/**
 * Every answer the seeded preferences row holds.
 *
 * The values are the permissive profile on purpose — `diet: 'none'`, no
 * allergens, no dislikes and the loosest 60-minute cooking limit — because the
 * recipe coverage matrix guarantees at least four eligible recipes per slot for
 * exactly that profile, and a developer's first `POST /api/meal-planning/plans`
 * failing with `no_matching_meals` would read as a bug in the planner rather
 * than as a narrow seed.
 *
 * `setup_status: 'completed'` with `setup_step: 'review'` is the authentic
 * post-generation pairing, not a guess: `mealPlan.service.ts` writes
 * `{setup_status: 'completed'}` alone on a first publish, leaving whatever step
 * review left behind, and `preferences.logic.ts` is what puts `'review'` there.
 * `'completed'` is also one of the two statuses the planner will generate from.
 *
 * `review_start_date` stays null deliberately. A stored start date would be a
 * date, and every seeded date decays: the allowed range begins at today, so a
 * date written this morning is out of bounds by next week and would turn a
 * silent convenience into a validation failure nobody would connect to the
 * seed. Null means "no override", and Review then offers its own default.
 *
 * `weight_source: 'manual'` follows the only precedent in the repository
 * (src/__tests__/setup/factories.ts) — no service writes that column, so this
 * borrows its vocabulary instead of inventing one.
 */
const DEV_PREFERENCE_ANSWERS = {
    // 'UTC' is a real IANA name and `normalizeTimeZone` resolves it, and it is
    // the right one HERE rather than a populated city zone: the diary buckets
    // this script seeds are computed for the UTC day (see `todayDayKey`), and
    // the server resolves "today" for plan bounds in this stored zone. Any
    // other value would let the two disagree by a day on a development box.
    time_zone: 'UTC',
    setup_status: 'completed',
    setup_step: 'review',
    review_start_date: null,
    target_route: 'estimated',
    goal: 'lose',
    // 170 lb, the goal weight the design's own sample uses, in the metric the
    // column stores. Below `weight_kg`, which is what "lose" requires of it.
    goal_weight_kg: 77.1,
    pace_lb_per_week: 1,
    age: 34,
    height_cm: 177.8,
    weight_kg: 82.6,
    weight_source: 'manual',
    sex_for_estimate: 'female',
    height_unit_pref: 'ft_in',
    weight_unit_pref: 'lb',
    activity_level: 'lightly_active',
    diet: 'none',
    allergens: [] as string[],
    disliked_food_ids: [] as string[],
    disliked_food_groups: [] as string[],
    meal_schedule: 'three',
    cooking_time_limit_min: 60,
    budget_amount: null,
    budget_currency: null,
    no_budget_preference: true,
    // What `preferences.logic.ts::deriveBudgetTier` returns for "no amount
    // given", so the stored tier agrees with the stored answer.
    budget_tier: 3,
    target_source: 'estimated',
    targets_revision: 1,
    // EQUAL to `revision`, and that equality is the whole point: staleness is
    // their inequality, so a confirmed estimate recorded against the revision
    // the row currently stands at is a FRESH one and `TargetsResponse.stale` is
    // false. Moving either number alone is how a suite reaches `stale: true`.
    targets_input_revision: 1,
    revision: 1,
    // Coherence only — no query reads it (see prisma/schema.prisma).
    estimate_inputs_revision: 1,
};

/**
 * An object typed as an interface is not assignable to `Prisma.InputJsonValue`
 * however JSON-safe its members are: TypeScript infers an implicit index
 * signature for a type alias but not for an interface. Same resolution, and the
 * same one-line shape, as `src/__tests__/setup/factories.ts`.
 */
const asJsonColumnValue = (value: object): Prisma.InputJsonValue => value as unknown as Prisma.InputJsonValue;

/** Every preference column this seed states, less the row's own identity. */
type PreferenceSeedFields = Omit<Prisma.meal_plan_preferencesUncheckedCreateInput, 'id' | 'user_id'>;

/**
 * The declared preference state as Prisma columns.
 *
 * A function rather than a constant so each call yields its own arrays and JSON
 * — a shared array handed to two Prisma calls is a mutable value crossing a
 * boundary that has no reason to share one.
 */
const developmentPreferenceFields = (): PreferenceSeedFields => ({
    ...DEV_PREFERENCE_ANSWERS,
    allergens: [...DEV_PREFERENCE_ANSWERS.allergens],
    disliked_food_ids: [...DEV_PREFERENCE_ANSWERS.disliked_food_ids],
    disliked_food_groups: [...DEV_PREFERENCE_ANSWERS.disliked_food_groups],
    meal_times: asJsonColumnValue(DEV_MEAL_TIMES.map((entry) => ({ slot: entry.slot, time: entry.time }))),
    // The snapshot side of the pair the module header explains, spelled with the
    // WIRE names `targets.logic.ts::confirmedSnapshotMatches` reads. It is
    // written in the same transaction as the `users` columns it must equal.
    confirmed_targets: asJsonColumnValue({ ...DEV_TARGETS }),
});

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
    /**
     * `--reset-user`: delete this one development user's rows before seeding.
     *
     * Scoped to the single user the other flags name and nothing else. It is a
     * `delete` on `users` by that id, which the schema's `ON DELETE CASCADE`
     * declarations carry down to that user's preferences, diary, weigh-ins,
     * foods, plans and workouts. It is deliberately NOT a truncate: a truncate
     * would take every other row in the database with it, and "do not reset a
     * database containing user data" is an absolute.
     */
    readonly resetUser: boolean;
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

// dbGuard's flag, REJECTED here rather than ignored.
//
// `catalog-load` and `recipes-seed` are `development_or_confirmed` and accept
// it, because they write shared reference data and can legitimately be asked to
// populate a shared environment. This script writes user-scoped rows and is
// `development_only`, so there is nothing for the flag to unlock. Silently
// consuming it would be the worse answer: an operator would come away believing
// they had authorised a database this script will never write to. Note the
// ordering that makes the rejection purely informative — the guard runs at
// module load, so a non-development origin has already been refused and
// exited(1) before this parser sees any argument; by the time the flag reaches
// here the origin is `development`, where it means nothing in any case.
const CONFIRM_TARGET_FLAG = '--confirm-target';

const RESET_USER_FLAG = '--reset-user';

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
        return { ok: true, options: { help: true, email: null, userId: null, date: null, resetUser: false } };
    }

    const errors: ArgumentError[] = [];
    let email: string | null = null;
    let emailSeen = false;
    let userId: string | null = null;
    let userIdSeen = false;
    let date: string | null = null;
    let dateSeen = false;
    let resetUser = false;

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

        if (flag === RESET_USER_FLAG) {
            // A switch, so an inline value is a mistake worth naming rather
            // than something to discard: `--reset-user=yes` reads as if the
            // value chose something.
            if (inlineValue !== null) {
                errors.push({ flag, message: `${flag} takes no value` });
                continue;
            }
            resetUser = true;
            continue;
        }

        if (flag === CONFIRM_TARGET_FLAG) {
            // Its value is consumed before the refusal purely so the database
            // name is not then reported a second time as an unknown flag.
            takeValue(inlineValue);
            errors.push({
                flag,
                message:
                    `${flag} is not a flag ${STAGE} accepts: it writes user-scoped rows and runs against a ` +
                    'development database only, so there is no confirmation door to open. It belongs to ' +
                    'catalog-load and recipes-seed, which write shared reference data.',
            });
            continue;
        }

        errors.push({ flag, message: `${flag} is not a flag ${STAGE} accepts` });
    }

    if (errors.length > 0) {
        return { ok: false, errors };
    }

    return { ok: true, options: { help: false, email, userId, date, resetUser } };
};

// ---------------------------------------------------------------------------
// Usage.
// ---------------------------------------------------------------------------

export const describeUsage = (): string =>
    [
        `Usage: npm run db:seed:dev -- [options]   (${STAGE})`,
        '',
        'Seeds a development database with one user whose meal-planning setup is',
        'complete: answered preferences, confirmed nutrition targets, a weigh-in and',
        'the four diary buckets for one day. That user can generate a week through',
        'POST /api/meal-planning/plans immediately, so reaching the Meal Plan',
        'screens needs no wizard run.',
        '',
        'Idempotent: a second run with the same flags changes nothing and reports',
        'unchanged for every object. The preferences row and the four target columns',
        'are CONVERGED to the development state on every run, so a row left',
        'half-answered is completed rather than skipped; the summary names whatever',
        'it rewrote.',
        '',
        'Options:',
        '  --email <addr>       Email for the seeded user. Must be unique in the',
        `                       database. Default: ${DEFAULT_DEV_USER_EMAIL}`,
        '  --user-id <id>       Id for the seeded user; users.id has no database',
        '                       default, so a fixed value is what makes a rerun a',
        `                       no-op. Default: ${DEFAULT_DEV_USER_ID}`,
        '  --date <YYYY-MM-DD>  The day the diary buckets are created for, as a real',
        '                       calendar date. Default: today (UTC).',
        '  --reset-user         Delete this one user and everything cascading from it',
        '                       (preferences, diary, weigh-ins, foods, plans) before',
        '                       seeding, for a clean slate. Scoped to that single',
        '                       user: it never truncates a table and never touches',
        '                       another row.',
        '  --help, -h           Print this usage block and exit 0.',
        '',
        'What it writes:',
        '  users                  one row, upserted by id, carrying the four',
        `                         target columns (${DEV_TARGETS.calories} kcal, ` +
            `${DEV_TARGETS.protein}P / ${DEV_TARGETS.carbs}C / ${DEV_TARGETS.fat}F)`,
        '  meal_plan_preferences  one row, upserted by user_id: setup_status',
        '                         completed, the development answers, and the',
        '                         confirmed_targets snapshot matching those four',
        '                         columns — written in the same transaction, because',
        '                         the two disagreeing is what makes the targets read',
        '                         report source "legacy"',
        `  meals                  ${DIARY_MEAL_NAMES.join(', ')} for the target date,`,
        '                         sort_order 0-3, created only where the day has no',
        '                         live row of that name (soft-deleted rows ignored)',
        '  body_weight_entries    one weigh-in, only when the user has none, so the',
        '                         About-you weight prefill has something to offer',
        '',
        'What it does NOT write, deliberately:',
        '  catalog_foods, recipes, recipe_versions and their children — install those',
        '  with "npm run catalog:load -- --release v1" and "npm run recipes:seed".',
        '  meal_plans and grocery_items — a development week comes from calling',
        '  POST /api/meal-planning/plans, so the generator is the code under test.',
        '  foods — getFoodsForUser already seeds the starter library on first read,',
        '  and any row written here would suppress it permanently.',
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
    // A read of information_schema only, and the names come from
    // REQUIRED_TABLES rather than a second literal list, so adding a table to
    // the requirement cannot leave the query asking about the old set — which
    // is exactly the drift a duplicated IN list produced here once.
    //
    // They travel as BOUND PARAMETERS, which is safe and not a loophole: each
    // is compared as a value against the `table_name` column, never
    // interpolated as an identifier, so there is no SQL for a name to escape
    // into. `Prisma.join` builds the placeholder list.
    const rows = await prisma.$queryRaw<Array<{ table_name: string }>>`
        SELECT table_name
        FROM information_schema.tables
        WHERE table_schema = 'public'
          AND table_name IN (${Prisma.join([...REQUIRED_TABLES])})
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

/**
 * What happened to one row: created, rewritten, or already exactly as declared.
 * `unchanged` everywhere is what "a rerun changes nothing" means concretely.
 */
export type RowOutcome = 'created' | 'updated' | 'unchanged';

/** Who is being seeded. Injected, so nothing here reads a default from argv. */
export interface DevelopmentIdentity {
    readonly userId: string;
    readonly email: string;
}

/** What one run did, per object, so created and unchanged are never conflated. */
export interface SeedSummary {
    readonly userId: string;
    readonly email: string;
    readonly date: string;
    /** Whether `--reset-user` actually removed a row (false when none existed). */
    readonly userReset: boolean;
    readonly userOutcome: RowOutcome;
    readonly preferencesOutcome: RowOutcome;
    readonly mealsCreated: readonly string[];
    readonly mealsExisting: readonly string[];
    readonly weighInOutcome: 'created' | 'existing';
    /** True when the run wrote anything at all — the headline a rerun denies. */
    readonly changed: boolean;
}

/**
 * Everything the run needs, injected rather than read from the module, so the
 * whole seed is reachable from a caller that supplies its own client and clock
 * (Rule backend-architecture §11 prefers dependency injection over mocking —
 * and `jest.config.ts` roots at `src`, so this folder holds no test of its own
 * for it to be mocked by in any case).
 */
export interface SeedDevOptions {
    /** The client every write goes through. */
    readonly client: PrismaClient;
    /**
     * The clock, injected so a caller can fix the day rather than depend on
     * the machine's. It supplies the diary day when `dayKey` is omitted, and
     * the weigh-in's `logged_at`.
     */
    readonly now: () => Date;
    readonly identity: DevelopmentIdentity;
    /** The diary day as `YYYY-MM-DD`; omitted, the clock's UTC day is used. */
    readonly dayKey?: string;
    /** Delete this one user's rows before seeding them (see {@link SeedOptions.resetUser}). */
    readonly resetUser?: boolean;
}

/**
 * Structural equality, INDEPENDENT OF OBJECT KEY ORDER, for deciding whether a
 * stored column already holds the declared value.
 *
 * The key-order independence is the load-bearing part and the reason
 * `JSON.stringify` is not used for this. `meal_times` and `confirmed_targets`
 * are `jsonb`, which stores an object's keys in its own order — by key length,
 * then bytewise — so the snapshot written as `{calories, protein, carbs, fat}`
 * reads back as `{fat, carbs, protein, calories}`. Stringifying either side
 * would then differ on every rerun and the summary would report `updated`
 * forever, which is precisely the claim this comparison exists to make
 * truthfully.
 */
const sameColumnValue = (stored: unknown, declared: unknown): boolean => {
    if (stored instanceof Date || declared instanceof Date) {
        return stored instanceof Date && declared instanceof Date && stored.getTime() === declared.getTime();
    }

    if (Array.isArray(stored) || Array.isArray(declared)) {
        return (
            Array.isArray(stored) &&
            Array.isArray(declared) &&
            stored.length === declared.length &&
            stored.every((value, index) => sameColumnValue(value, declared[index]))
        );
    }

    const storedIsObject = typeof stored === 'object' && stored !== null;
    const declaredIsObject = typeof declared === 'object' && declared !== null;

    if (storedIsObject || declaredIsObject) {
        if (!storedIsObject || !declaredIsObject) {
            return false;
        }

        const storedKeys = Object.keys(stored as Record<string, unknown>).sort();
        const declaredKeys = Object.keys(declared as Record<string, unknown>).sort();

        return (
            storedKeys.length === declaredKeys.length &&
            storedKeys.every((key, index) => key === declaredKeys[index]) &&
            storedKeys.every((key) =>
                sameColumnValue(
                    (stored as Record<string, unknown>)[key],
                    (declared as Record<string, unknown>)[key],
                ),
            )
        );
    }

    return stored === declared;
};

/** Whether every column this seed declares already holds the declared value. */
const matchesDeclaredColumns = (stored: Record<string, unknown>, declared: Record<string, unknown>): boolean =>
    Object.keys(declared).every((column) => sameColumnValue(stored[column], declared[column]));

/**
 * Every `users` column this seed states, less the row's own id. `Pick` rather
 * than `Omit` because the list is short and worth reading: the identity, and
 * the four targets whose snapshot the preferences row carries.
 */
type UserSeedFields = Pick<
    Prisma.usersUncheckedCreateInput,
    'email' | 'target_calories' | 'target_protein_g' | 'target_carbs_g' | 'target_fat_g'
>;

/**
 * The declared `users` columns.
 *
 * Deliberately NOT `first_name`/`last_name`. `--user-id` can name a real
 * Firebase uid, and nothing in meal planning reads a name, so the seed has no
 * business renaming a signed-in developer's account to reach the Meal Plan tab.
 * The default identity is unmistakable from its id and address alone.
 */
const developmentUserFields = (email: string): UserSeedFields => ({
    email,
    ...developmentUserTargetColumns(),
});

/** Both declared shapes as the plain records {@link matchesDeclaredColumns} compares. */
const asColumnRecord = (value: object): Record<string, unknown> => value as unknown as Record<string, unknown>;

/**
 * Everything in one interactive transaction, so a run either leaves a complete,
 * plan-ready development user or leaves the database exactly as it was. The
 * targets are the reason this matters beyond tidiness: `users.target_*` and
 * `confirmed_targets` are compared against each other by the canonical read, so
 * a run that wrote one and failed before the other would leave a user the
 * planner refuses as `legacy` — see the module header.
 */
export const runSeed = async (options: SeedDevOptions): Promise<SeedSummary> => {
    const { client, identity } = options;
    const dayKey = options.dayKey ?? todayDayKey(options.now());
    const date = parseDayKey(dayKey);

    if (date === null) {
        // Unreachable through main, which parses the flag and defaults from
        // `todayDayKey`; kept because `runSeed` is exported behaviour and a
        // silent `new Date(undefined)` would write an invalid date. Thrown
        // rather than returned because there is no partial seed to report: no
        // transaction has opened yet.
        throw new SeedDevError(`${dayKey} is not a calendar date as YYYY-MM-DD`, 'invalid_date', dayKey);
    }

    return client.$transaction(async (tx) => {
        // `deleteMany` rather than `delete` so an absent user is a count of 0
        // instead of a P2025 to catch, and the predicate is the owner key
        // itself (§5.1: for `users`, `id` IS the owner key). The schema's
        // ON DELETE CASCADE declarations carry it to this user's preferences,
        // diary, weigh-ins, foods, plans and workouts — nothing else, and
        // never a truncate.
        const resetCount = options.resetUser
            ? (await tx.users.deleteMany({ where: { id: identity.userId } })).count
            : 0;

        const declaredUser = developmentUserFields(identity.email);
        const existingUser = await tx.users.findUnique({
            where: { id: identity.userId },
            select: {
                email: true,
                target_calories: true,
                target_protein_g: true,
                target_carbs_g: true,
                target_fat_g: true,
            },
        });

        const userOutcome: RowOutcome =
            existingUser === null
                ? 'created'
                : matchesDeclaredColumns(asColumnRecord(existingUser), asColumnRecord(declaredUser))
                  ? 'unchanged'
                  : 'updated';

        if (userOutcome !== 'unchanged') {
            await tx.users.upsert({
                where: { id: identity.userId },
                create: { id: identity.userId, ...declaredUser },
                update: declaredUser,
            });
        }

        const declaredPreferences = developmentPreferenceFields();
        const existingPreferences = await tx.meal_plan_preferences.findUnique({
            where: { user_id: identity.userId },
        });

        const preferencesOutcome: RowOutcome =
            existingPreferences === null
                ? 'created'
                : matchesDeclaredColumns(asColumnRecord(existingPreferences), asColumnRecord(declaredPreferences))
                  ? 'unchanged'
                  : 'updated';

        // CONVERGED, not create-if-absent: a row left half-answered by an
        // abandoned wizard run is completed here, because "this user can
        // generate a week" is the guarantee the script exists to make and a
        // skipped row cannot honour it. The write is skipped only when the row
        // already holds every declared value, so a rerun touches nothing.
        if (preferencesOutcome !== 'unchanged') {
            await tx.meal_plan_preferences.upsert({
                where: { user_id: identity.userId },
                create: { user_id: identity.userId, ...declaredPreferences },
                update: declaredPreferences,
            });
        }

        const mealsCreated: string[] = [];
        const mealsExisting: string[] = [];

        // `meals` has no unique constraint over (user_id, date, name) — the app
        // lets a user add and rename meals freely — so this is a scoped lookup
        // and a conditional insert rather than an upsert. Every predicate
        // carries `user_id` (§5.1) and `deleted_at: null`, so a bucket the user
        // deleted stays deleted and is recreated as a new row instead of being
        // revived. `sort_order` is the index, which is the same value
        // `getDailyMacros` assigns when it self-heals a day, so a seeded day
        // sorts identically to a lazily created one.
        for (let index = 0; index < DIARY_MEAL_NAMES.length; index += 1) {
            const name = DIARY_MEAL_NAMES[index];
            const existingMeal = await tx.meals.findFirst({
                where: { user_id: identity.userId, date, name, deleted_at: null },
                select: { id: true },
            });

            if (existingMeal !== null) {
                mealsExisting.push(name);
                continue;
            }

            await tx.meals.create({
                data: { user_id: identity.userId, date, name, sort_order: index },
            });
            mealsCreated.push(name);
        }

        // The weigh-in follows the shipped reasoning of
        // `food.service.ts::seedStarterFoodsIfEmpty` exactly: seed only when
        // the user has never had one. The count carries no date or state
        // filter, so a weigh-in the developer deleted counts as "had" and is
        // not resurrected — and one weigh-in is all the About-you prefill
        // reads, so a second would be noise.
        const weighInCount = await tx.body_weight_entries.count({ where: { user_id: identity.userId } });
        const weighInOutcome: SeedSummary['weighInOutcome'] = weighInCount > 0 ? 'existing' : 'created';

        if (weighInOutcome === 'created') {
            await tx.body_weight_entries.create({
                data: {
                    user_id: identity.userId,
                    weight: DEV_WEIGH_IN_WEIGHT_AS_TYPED,
                    logged_at: options.now(),
                },
            });
        }

        return {
            userId: identity.userId,
            email: identity.email,
            date: dayKey,
            userReset: resetCount > 0,
            userOutcome,
            preferencesOutcome,
            mealsCreated,
            mealsExisting,
            weighInOutcome,
            changed:
                resetCount > 0 ||
                userOutcome !== 'unchanged' ||
                preferencesOutcome !== 'unchanged' ||
                mealsCreated.length > 0 ||
                weighInOutcome === 'created',
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
 * Every error class this stage can raise or observe gets its own reported code:
 * its own `SeedDevError` first, then the guard's `DatabaseOriginError`, then
 * Prisma's.
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
    if (error instanceof SeedDevError) {
        return { code: error.code, error: safeError(error) };
    }
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
    // Retained below `SeedDevError`, which is what this stage throws for a bad
    // day key now. A built-in `RangeError` can still reach here from elsewhere
    // — `Intl` and the `Date` constructor raise it — and reporting that under
    // the same code is more useful than `unexpected_error`.
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

    const identity: DevelopmentIdentity = {
        userId: parsed.options.userId === null ? DEFAULT_DEV_USER_ID : parsed.options.userId,
        email: parsed.options.email === null ? DEFAULT_DEV_USER_EMAIL : parsed.options.email,
    };
    // Resolved here rather than inside the run, so the day that is logged is
    // provably the day that is seeded.
    const dayKey = parsed.options.date === null ? todayDayKey() : parsed.options.date;

    logger.info('stage_invoked', {
        stage: STAGE,
        userId: identity.userId,
        email: identity.email,
        date: dayKey,
        resetUser: parsed.options.resetUser,
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

        const summary = await runSeed({
            client: prisma,
            now: () => new Date(),
            identity,
            dayKey,
            resetUser: parsed.options.resetUser,
        });

        // `changed: false` is the honest form of "idempotent": a rerun says so
        // per object rather than leaving an operator to infer it from silence.
        logger.info('seed_complete', {
            stage: STAGE,
            userId: summary.userId,
            email: summary.email,
            date: summary.date,
            changed: summary.changed,
            userReset: summary.userReset,
            users: summary.userOutcome,
            mealPlanPreferences: summary.preferencesOutcome,
            confirmedTargets: `${DEV_TARGETS.calories} kcal, ${DEV_TARGETS.protein}P / ${DEV_TARGETS.carbs}C / ${DEV_TARGETS.fat}F`,
            targetSource: DEV_PREFERENCE_ANSWERS.target_source,
            bodyWeightEntries: summary.weighInOutcome,
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

// Guarded so importing this module for runSeed, parseArgs, preflight,
// parseDayKey or describeUsage never seeds a database: the import gives a
// caller the behaviour, and running the file is what invokes it. Note that
// dbGuard's own module-load enforcement is keyed off argv[1], so an import from
// somewhere else is inert there too.
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
