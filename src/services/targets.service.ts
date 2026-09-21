// The nutrition-target service: the canonical read of a user's targets, the
// calculated estimate behind the review screen, the single canonical WRITE, and
// the gate that stops a week being built on numbers nobody confirmed.
//
// Orchestration only (Rule backend-architecture §5). Every decision belongs to
// `targets.logic.ts` and is delegated to it: the Mifflin-St Jeor equation, the
// activity factors, the goal adjustment, the calorie bounds, the macro split,
// the manual-value validation, the feasibility warnings, and — the load-bearing
// one — `deriveTargetsResponse`, which decides what `complete`, `source` and
// `stale` mean. Nothing here re-decides any of it.
//
// WHY THIS FILE IS THE SINGLE CANONICAL WRITER. `users.target_*` is written by
// exactly two paths: the untouched legacy `PUT /api/user/targets`, and this one.
// `saveTargets` writes those four columns THROUGH
// `nutrition.service.ts::updateTargets(userId, values, tx)` — the existing
// function, called with this transaction's client — rather than issuing its own
// UPDATE, so there is one statement in the codebase that writes a target value
// and one place a future change to that write lands. In the same transaction it
// records `confirmed_targets`, `target_source`, `targets_input_revision`,
// `estimated_targets` and `targets_revision + 1` on `meal_plan_preferences`,
// which is what makes the canonical read able to tell a confirmed target from a
// legacy one at all: the legacy route never bumps the revision and leaves no
// other trace, so the snapshot written here is the only record of what was
// confirmed. `estimated_targets` is the companion record of HOW an estimated
// figure was reached — AAP §0.5.1's "last estimate with input revision" — and
// exists because the derivation behind a confirmed estimate is otherwise gone
// the moment the response is sent. Both halves must commit or neither, or a
// confirmed target would be recorded against preferences that never got it.
//
// NEVER GATED BY THE FEATURE FLAG. `/meal-planning/targets*` stays available
// with `MEAL_PLANNING_ENABLED` off, because Account, Progress and the diary read
// and write targets through these routes; the flag gates the plan routes only,
// and the gate itself lives in the controller.
//
// TWO ERROR SHAPES, DELIBERATELY DIFFERENT (§8). A malformed body is RETURNED as
// a verdict — the pure parsers' own convention, and there is no
// `InvalidRequestError` class in the shared vocabulary — while a state conflict
// is THROWN as one of the typed classes in `mealPlanning.errors.ts`
// (`StaleTargetsError`, `EstimateStaleError`, `EstimateUnavailableError`,
// `TargetsMissingError`, `TargetsUnconfirmedError`), because each carries data
// the client acts on and each maps to a different status. The controller maps
// both; this file picks no status code.

import { Prisma } from '../generated/prisma';
import { prisma } from '../prisma/client';
import {
    MealPlanMacroTotals,
    NutritionTargetValues,
    SaveTargetsResponse,
    StoredEstimateSnapshot,
    TargetEstimateResponse,
    TargetRoute,
    TargetsResponse,
} from '../types/mealPlanning';
import {
    EstimateStaleError,
    EstimateUnavailableError,
    StaleTargetsError,
    TargetsMissingError,
    TargetsUnconfirmedError,
} from './mealPlanning.errors';
import { MealPlanningTransactionClient, withUserLock } from './mealPlanningAction.service';
import { updateTargets } from './nutrition.service';
import { PreferencesRow, loadPreferencesRow } from './preferences.service';
// The setup-state projection is a pure business rule in the preferences LOGIC
// module, not a function of its service: both endpoints that can advance the
// resume marker must read the row through the same closed vocabularies, and a
// service importing another service would couple two orchestration layers for
// a projection that performs no I/O (Rule backend-architecture §5, §7).
import { setupStateOf } from './preferences.logic';
import {
    EstimatedSaveRequest,
    ManualSetupAdvance,
    TargetsErrorVerdict,
    TargetsPreferencesRow,
    TargetsUserRow,
    assessFeasibility,
    buildStoredEstimate,
    computeTargetEstimate,
    deriveTargetsResponse,
    parseSaveTargetsRequest,
    resolveEstimateInputs,
    resolveManualTargetSetupAdvance,
} from './targets.logic';

/* ---------------------------------------------------------------------------
 * The four columns, and the row they live in
 * ------------------------------------------------------------------------- */

/**
 * The four target fields in wire order.
 *
 * Typed as keys of `NutritionTargetValues`, so renaming a member of that DTO
 * stops this compiling rather than silently emitting a field name the client
 * does not recognise. `targets.logic.ts` keeps the same list privately for its
 * own parsers; this one exists because `TargetsMissingError` needs to NAME the
 * unset fields and that list is not exported.
 */
const TARGET_FIELDS: readonly (keyof NutritionTargetValues)[] = ['calories', 'protein', 'carbs', 'fat'];

/**
 * The four `users.target_*` columns as stored.
 *
 * A user with no `users` row reads back as all-null, which
 * `deriveTargetsResponse` already has a defined answer for — `targets: null`,
 * `complete: false`, `source: null`. That is the honest reading: the row cannot
 * hold a target it does not have. It is also unreachable on an authenticated
 * request, since the account is created before any token is issued for it.
 */
const NO_STORED_TARGETS: TargetsUserRow = {
    target_calories: null,
    target_protein_g: null,
    target_carbs_g: null,
    target_fat_g: null,
};

/**
 * Whether a target read also pins the owning `users` row against the legacy
 * writer for the rest of the transaction.
 *
 *  - `'read_only'` — no lock. Every display read: `GET /meal-planning/targets`,
 *    Account, Progress, and the plan response's current-targets reconciliation.
 *    A value that changes the instant after it was read is not a correctness
 *    problem for a screen; an INCOHERENT PAIR would be, which is why even this
 *    mode is one statement.
 *  - `'locked_for_write'` — `SELECT … FOR UPDATE OF u`. The publication gate,
 *    and only inside an interactive transaction: the row lock is held until
 *    COMMIT, so `PUT /api/user/targets` — which writes `users.target_*` outside
 *    the per-user advisory lock by design — cannot commit between the check and
 *    the plan insert.
 */
type TargetsReadMode = 'read_only' | 'locked_for_write';

/** `FOR UPDATE OF u` — the non-nullable side of the outer join, the only side Postgres allows locking. */
const USERS_ROW_LOCK = Prisma.sql`FOR UPDATE OF u`;

/**
 * The join as it comes back from Postgres. Every `p.*` column is nullable here
 * whatever the table says, because a LEFT JOIN with no match fills them all
 * with NULL; `preferences_user_id` is the sentinel that tells the two cases
 * apart, since `meal_plan_preferences.user_id` is NOT NULL and unique.
 */
interface TargetsJoinRow {
    target_calories: number | null;
    target_protein_g: number | null;
    target_carbs_g: number | null;
    target_fat_g: number | null;
    preferences_user_id: string | null;
    target_source: string | null;
    targets_revision: number | null;
    confirmed_targets: unknown;
    targets_input_revision: number | null;
    revision: number | null;
    /**
     * The route and the seven answers the estimate is computed from.
     * `deriveTargetsResponse` recomputes the estimate from these to decide
     * whether a confirmed one is stale, so they are read in the SAME statement
     * as the record they are judged against — a second read could recompute
     * against answers that no longer belong to the snapshot the confirmed
     * figure was compared with.
     */
    target_route: string | null;
    goal: string | null;
    pace_lb_per_week: number | null;
    age: number | null;
    height_cm: number | null;
    weight_kg: number | null;
    sex_for_estimate: string | null;
    activity_level: string | null;
}

/** The two rows `deriveTargetsResponse` judges, read together. */
interface StoredTargetsPair {
    user: TargetsUserRow;
    preferences: TargetsPreferencesRow | null;
}

/**
 * The stored targets of one user and the record that attributes them, read in
 * ONE STATEMENT.
 *
 * WHY ONE STATEMENT AND NOT TWO READS. The verdict
 * `deriveTargetsResponse` reaches is a COMPARISON BETWEEN THESE TWO ROWS: the
 * four `users.target_*` columns against `confirmed_targets`. Read as two
 * statements, each takes its own READ COMMITTED snapshot, and the untouched
 * `PUT /api/user/targets` — which holds no meal-planning lock — can commit
 * between them. The pair then looks self-consistent (`users` T1 equals the
 * snapshot T1, so the source resolves to a confirmed route) while the committed
 * canonical value is already T2, and a week can be published against T1 and
 * presented as confirmed. One statement is one snapshot, so that reading cannot
 * be assembled: either both rows predate the legacy write or both follow it,
 * and in the second case the values differ from the snapshot and the source is
 * `legacy` — exactly the signal the planner refuses on.
 *
 * `WHERE u.id = $1` IS the owner key (§5.1) — the primary key of the owning row
 * — so the read is user-scoped by construction, and the join predicate
 * `p.user_id = u.id` keeps the preferences half scoped to the same owner. No
 * other column of either table is projected: nothing else about the user
 * belongs in a target response.
 *
 * A user with no `users` row yields no rows at all, which reads back as
 * all-null targets — the honest answer, since a row cannot hold a target it does
 * not have. It is unreachable on an authenticated request, because the account
 * exists before any token is issued for it.
 */
const readStoredTargets = async (
    userId: string,
    db: Prisma.TransactionClient,
    mode: TargetsReadMode,
): Promise<StoredTargetsPair> => {
    const rows = await db.$queryRaw<TargetsJoinRow[]>(Prisma.sql`
        SELECT
            u.target_calories,
            u.target_protein_g,
            u.target_carbs_g,
            u.target_fat_g,
            p.user_id AS preferences_user_id,
            p.target_source,
            p.targets_revision,
            p.confirmed_targets,
            p.targets_input_revision,
            p.revision,
            p.target_route,
            p.goal,
            p.pace_lb_per_week,
            p.age,
            p.height_cm,
            p.weight_kg,
            p.sex_for_estimate,
            p.activity_level
        FROM users u
        LEFT JOIN meal_plan_preferences p ON p.user_id = u.id
        WHERE u.id = ${userId}
        ${mode === 'locked_for_write' ? USERS_ROW_LOCK : Prisma.empty}
    `);

    const row = rows[0];

    if (row === undefined) {
        return { user: NO_STORED_TARGETS, preferences: null };
    }

    return {
        user: {
            target_calories: row.target_calories,
            target_protein_g: row.target_protein_g,
            target_carbs_g: row.target_carbs_g,
            target_fat_g: row.target_fat_g,
        },
        preferences: readPreferencesHalf(row),
    };
};

/**
 * The preferences half of the join, or null when the user has no row.
 *
 * The two NOT NULL revision columns are re-checked because a raw projection is
 * typed by hand: the only way they can arrive NULL is the no-row case the
 * sentinel has already answered, so this cannot fire — and if it ever did,
 * failing loudly is the only alternative to inventing a revision that a stale
 * check or a client's pin would then be compared against.
 */
const readPreferencesHalf = (row: TargetsJoinRow): TargetsPreferencesRow | null => {
    if (row.preferences_user_id === null) {
        return null;
    }

    if (row.targets_revision === null || row.revision === null) {
        throw new Error(
            `meal_plan_preferences row for ${row.preferences_user_id} returned NULL in a NOT NULL revision column`,
        );
    }

    return {
        target_source: row.target_source,
        targets_revision: row.targets_revision,
        confirmed_targets: row.confirmed_targets,
        targets_input_revision: row.targets_input_revision,
        revision: row.revision,
        // The estimate inputs are carried through unvalidated on purpose:
        // `resolveEstimateInputs` is the one place that decides whether a
        // stored answer is usable, and re-deciding it here is how two callers
        // would come to disagree about the same row.
        target_route: row.target_route,
        goal: row.goal,
        pace_lb_per_week: row.pace_lb_per_week,
        age: row.age,
        height_cm: row.height_cm,
        weight_kg: row.weight_kg,
        sex_for_estimate: row.sex_for_estimate,
        activity_level: row.activity_level,
    };
};

/* ---------------------------------------------------------------------------
 * GET /meal-planning/targets
 * ------------------------------------------------------------------------- */

/**
 * `GET /api/meal-planning/targets` — the canonical target read that Review, plan
 * settings, Account, Progress and the planner all act on.
 *
 * Two rows in, one verdict out, and this function DECIDES NOTHING: what
 * `complete`, `source` and `stale` mean is `deriveTargetsResponse`'s, including
 * the `legacy` attribution that compares the stored values with the confirmed
 * snapshot. A second opinion here is precisely how one surface would come to
 * show "review your targets" while another silently planned a week on the same
 * numbers.
 *
 * THE TWO ROWS ARE READ IN ONE STATEMENT, so the pair is always one consistent
 * snapshot even while the untouched legacy writer is committing (see
 * {@link readStoredTargets}). This read takes no lock: a display value that
 * moves the moment after it was read is not a correctness problem, and locking
 * the owning row on a GET would make every screen wait behind a target write.
 * The WRITE path is what needs the lock, and it asks for it explicitly through
 * {@link requireConfirmedTargets}.
 */
export const getTargets = async (
    userId: string,
    db: Prisma.TransactionClient = prisma,
): Promise<TargetsResponse> => {
    const { user, preferences } = await readStoredTargets(userId, db, 'read_only');

    return deriveTargetsResponse(user, preferences);
};

/* ---------------------------------------------------------------------------
 * GET /meal-planning/targets/estimate
 * ------------------------------------------------------------------------- */

/**
 * `GET /api/meal-planning/targets/estimate` — the calculated estimate,
 * recomputed from stored preferences on every read.
 *
 * NOTHING IS PERSISTED BY READING. The estimate is a derivation, not a record:
 * the response carries `estimateRevision` (the preferences revision its inputs
 * came from) so the save can refuse numbers computed from inputs that have since
 * changed, and storing the figure here would create a second source for it that
 * could then disagree with the inputs it claims to come from.
 *
 * A user with no preferences row is `missing_inputs` — the same reason a row
 * with gaps gets — because the two lead to the same place: manual entry. The
 * other reason, `prefer_not_to_say`, is an answer rather than a gap and
 * `resolveEstimateInputs` reports it as itself so the client can distinguish the
 * user's own choice from a form they have not finished.
 *
 * A USER ON THE MANUAL ROUTE GETS NO ESTIMATE, whatever their row still holds.
 * The whole preferences row is handed to `resolveEstimateInputs` — never a
 * measurements-only projection — so the persisted `target_route` is part of the
 * availability decision it makes. That matters because Skip stores no
 * measurements and leaves the previous ones in place (AAP §0.5.2), so a row that
 * has taken the manual route can look perfectly estimable; calculating from it
 * would answer a question the user declined to ask.
 *
 * THROWS rather than returning null: `EstimateUnavailableError` carries the
 * reason the client routes on, and 409 with a machine-readable reason is the
 * declared contract for this route — a null would collapse both reasons into a
 * 404 that says nothing.
 */
export const getTargetEstimate = async (
    userId: string,
    db: Prisma.TransactionClient = prisma,
): Promise<TargetEstimateResponse> => {
    const row = await loadPreferencesRow(userId, db);

    if (row === null) {
        throw new EstimateUnavailableError('missing_inputs');
    }

    const resolved = resolveEstimateInputs(row);

    if (resolved.kind === 'unavailable') {
        throw new EstimateUnavailableError(resolved.reason);
    }

    return computeTargetEstimate(resolved.inputs, row.revision);
};

/* ---------------------------------------------------------------------------
 * PUT /meal-planning/targets — the envelope
 *
 * The parser itself lives in `targets.logic.ts` with every other request parser
 * (Rule backend-architecture §2); this file only calls it and returns its
 * refusal verbatim. What remains here is the one Prisma column concern the
 * write needs.
 * ------------------------------------------------------------------------- */

/**
 * The confirmed snapshot as the JSONB column takes it.
 *
 * The cast is unavoidable: Prisma's `InputJsonValue` requires a string index
 * signature, which a declared interface does not have even when every member of
 * it is a JSON number. Confined to this one helper, as
 * `mealPlanningAction.service.ts` confines its own, so no call site carries a
 * cast — and narrowed to the snapshot type rather than `unknown`, so it cannot
 * be used to smuggle a different shape into the column
 * `targets.logic.ts::confirmedSnapshotMatches` reads.
 */
const asSnapshotColumnValue = (values: MealPlanMacroTotals): Prisma.InputJsonValue =>
    values as unknown as Prisma.InputJsonValue;

/**
 * The stored estimate as the JSONB column takes it, or `undefined` when this
 * save computed no estimate.
 *
 * `undefined` IS PRISMA'S "DO NOT WRITE THIS COLUMN", and that is the whole
 * manual-save rule in one value: a manual confirmation leaves
 * `estimated_targets` exactly where it stood, and on the create arm falls
 * through to the column's own SQL default of NULL. It is NOT
 * `Prisma.JsonNull`, which would clear the column — the reasoning for
 * retaining rather than clearing is in {@link writeConfirmedTargets}. Omission
 * is also why this column needs no coordination with the preference saves:
 * `estimated_targets` is written by this endpoint alone, and every column a
 * preference save writes is absent from the data this one builds, so the two
 * update the same row without either having to know what the other left behind.
 *
 * The cast is unavoidable for the reason {@link asSnapshotColumnValue} gives —
 * `InputJsonValue` wants a string index signature a declared interface does not
 * have — and is confined here, narrowed to the stored shape rather than
 * `unknown`, so no call site carries a cast and no other shape can reach the
 * column.
 */
const asStoredEstimateColumnValue = (
    estimate: StoredEstimateSnapshot | null,
): Prisma.InputJsonValue | undefined =>
    estimate === null ? undefined : (estimate as unknown as Prisma.InputJsonValue);

/* ---------------------------------------------------------------------------
 * PUT /meal-planning/targets — the write
 * ------------------------------------------------------------------------- */

/** The outcome of a save: the response, or the envelope parser's refusal verbatim. */
export type SaveTargetsResult = { kind: 'ok'; response: SaveTargetsResponse } | TargetsErrorVerdict;

/** The revision a preferences row created by a target save carries (AAP §0.5.2). */
const FIRST_REVISION = 1;

/** The status a row created by a target save carries — see {@link saveTargets}. */
const NOT_STARTED_SETUP_STATUS = 'not_started';

/**
 * The values a save will store, and the preferences revision that produced
 * them.
 *
 * `targetsInputRevision` is non-null only for a confirmed ESTIMATE: it is the
 * `meal_plan_preferences.revision` whose goal, body, activity and pace produced
 * the figure (AAP §0.5.1), and `TargetsResponse.stale` is exactly its
 * inequality with the CURRENT `revision` (§0.5.2). It is the same number the
 * request's `estimateRevision` pins, so what the client confirmed against and
 * what is recorded as the figure's ancestry cannot diverge.
 *
 * Manual targets carry null, because the user typed them and a later change of
 * inputs says nothing about them — leaving a previous estimate's input revision
 * behind would make a manual target claim an ancestry it does not have.
 *
 * `estimate` is the whole recomputed figure the estimated arm confirmed, kept
 * so the write can record it as `meal_plan_preferences.estimated_targets` (AAP
 * §0.5.1's "last estimate with input revision"). It is null for a manual save,
 * which computes no estimate — and null here means "write nothing to that
 * column", never "clear it" (see {@link writeConfirmedTargets}). Carrying the
 * derivation rather than only the four values is the point: the bmr, the
 * maintenance rate, the adjustment and the clamp are what make the stored
 * record an account of HOW the figure was reached, and they exist nowhere else
 * once the response has been sent.
 */
interface ResolvedTargetValues {
    values: MealPlanMacroTotals;
    targetsInputRevision: number | null;
    estimate: StoredEstimateSnapshot | null;
}

/**
 * The values behind a `source: 'estimated'` save, recomputed server-side.
 *
 * THE CLIENT NEVER SELF-DECLARES NUMBERS AS ESTIMATED — that is the whole point
 * of the estimated shape carrying no values. The server recomputes from the
 * stored preferences and refuses when `estimateRevision` no longer matches the
 * revision those preferences are at, because the figure on the user's screen was
 * then derived from answers that have since changed and confirming it would
 * store a number nobody reviewed.
 *
 * Availability is checked BEFORE staleness: `prefer_not_to_say`, a persisted
 * manual route and missing measurements all route the user to manual entry,
 * which is a different destination from "recalculate and confirm again", and the
 * more fundamental fork should be the one reported.
 *
 * THE ROUTE CHECK IS WHAT STOPS A DECLINED ESTIMATE BEING CONFIRMED. The
 * estimated arm of this save recomputes from the stored row, so without it a
 * user who pressed Skip — whose earlier measurements are deliberately retained
 * (AAP §0.5.2) — could have a calculated figure written to `users.target_*` and
 * attributed to the estimated route. The whole row is passed to
 * `resolveEstimateInputs`, which owns that decision.
 */
const resolveEstimatedValues = (
    row: PreferencesRow | null,
    request: EstimatedSaveRequest,
): ResolvedTargetValues => {
    if (row === null) {
        throw new EstimateUnavailableError('missing_inputs');
    }

    const resolved = resolveEstimateInputs(row);

    if (resolved.kind === 'unavailable') {
        throw new EstimateUnavailableError(resolved.reason);
    }

    if (request.estimateRevision !== row.revision) {
        throw new EstimateStaleError();
    }

    const estimate = computeTargetEstimate(resolved.inputs, row.revision);

    return {
        values: {
            calories: estimate.calories,
            protein: estimate.protein,
            carbs: estimate.carbs,
            fat: estimate.fat,
        },
        // The whole figure, not just the four values it resolved to: the stored
        // record is the only account of the derivation that survives this
        // request, and `buildStoredEstimate` is the one place its shape is
        // decided (it is deliberately not this response's shape).
        estimate: buildStoredEstimate(estimate),
        // `row.revision` is both what `estimateRevision` pins — the wire check a
        // few lines above, which refuses an estimate computed from answers that
        // have since changed — and what is RECORDED as this figure's ancestry,
        // because AAP §0.5.2 judges staleness as `targets_input_revision`
        // against the current `preferences.revision`. One counter for both jobs
        // is what makes "confirmed against revision N" and "derived from
        // revision N" the same statement.
        targetsInputRevision: row.revision,
    };
};

/** The targets record one save writes, beyond the state it writes it against. */
interface ConfirmedTargetsWrite {
    /** The route the request declared, stored as `target_source`. */
    source: TargetRoute;
    /** The four values and their ancestry, from {@link resolveEstimatedValues}. */
    resolved: ResolvedTargetValues;
    /** Whether the locked read found a row — the create/update fork. */
    rowExists: boolean;
    /** The `targets_revision` that read returned, which the UPDATE pins. */
    storedRevision: number;
    /**
     * The resume marker this save answers, or null when it answers none —
     * `targets.logic.ts::resolveManualTargetSetupAdvance`'s verdict, which is
     * null for every save but a manual confirmation on the manual route's own
     * target stop.
     */
    setupAdvance: ManualSetupAdvance | null;
}

/**
 * The current `targets_revision`, or 0 when the row is gone.
 *
 * Read only to answer a refused write truthfully: the client resolves
 * `StaleTargetsError` by comparing the authoritative revision with its own
 * draft, so reporting the revision this transaction *expected* would send it to
 * compare against a number that never existed. A deleted row reads as 0, which
 * is the same revision a user with no row has.
 */
const readTargetsRevision = async (
    db: Prisma.TransactionClient,
    userId: string,
): Promise<number> => {
    const row = await db.meal_plan_preferences.findUnique({
        where: { user_id: userId },
        select: { targets_revision: true },
    });

    return row?.targets_revision ?? 0;
};

/**
 * Store the confirmed targets record — and make the pinned revision part of the
 * statement rather than a promise the caller made a moment earlier.
 *
 * WHY THIS IS NOT AN UPSERT. `upsert({where: {user_id}})` writes whatever the
 * row currently holds, so the `expectedTargetsRevision` check would live only
 * in the application: correct while the lock holds, and silently unenforced the
 * moment anything writes `targets_revision` without taking it. Rule
 * `backend-architecture` §5.1 and AAP §0.5.1 require the owner AND the expected
 * revision in the predicate, so an existing row is updated through
 * `updateMany({user_id, targets_revision: storedRevision})` and the affected
 * count is checked: one row is the write this caller pinned, zero is a row that
 * moved or vanished, and the count makes the difference observable instead of
 * assumed. The increment then has a guaranteed starting value, because the same
 * predicate that authorised the write established it.
 *
 * Zero affected rows is REACHABLE, which is why the count is checked rather
 * than assumed. The advisory lock serialises this feature's own writes and
 * nothing else — the same asymmetry that makes `PUT /api/user/targets` a hazard
 * for the publication gate — so any statement that reaches this row without
 * taking it can move `targets_revision` between the locked read and this
 * update, and PostgreSQL then re-evaluates the waiting update against the row
 * as it has become. `StaleTargetsError` is the answer the contract already
 * defines for that (§0.5.2), so refusing costs the client no new behaviour:
 * it re-reads, compares with its draft, and resolves. The pair of tests in
 * `src/__tests__/api/targets.test.ts` ("the pinned targets revision as a write
 * predicate") drives exactly that interleaving from a second session, and the
 * counter-test there shows a merely-locked row still saves.
 *
 * FOUR COLUMNS, ONE STATEMENT. `target_source`, `confirmed_targets`,
 * `targets_input_revision` and `estimated_targets` are written together with
 * the bumped `targets_revision`, and together with `users.target_*` in the
 * caller's transaction. Splitting any of them out would allow a row that claims
 * a route it has no snapshot for, or an estimate record that explains numbers
 * the row does not hold.
 *
 * WHY A MANUAL SAVE RETAINS THE STORED ESTIMATE RATHER THAN CLEARING IT. AAP
 * §0.5.1 defines `estimated_targets` as the "last estimate with input
 * revision" — a record of the last estimate computed FOR THIS USER, not of the
 * figure currently confirmed. So a user who types their own targets after
 * confirming an estimate keeps that record: clearing it would destroy the only
 * account of a calculation that really happened, and it would do so on the one
 * route where the user is least likely to have any other trace of it. Nothing
 * can misread the retained value as the confirmed figure, because
 * `target_source` says which route was confirmed, `confirmed_targets` holds
 * what was confirmed, and the snapshot carries its own `inputRevision`.
 * A user who has never confirmed an estimate stores NULL, which is the honest
 * reading — no estimate was ever computed for them.
 *
 * A missing row is CREATED rather than upserted for the same reason in reverse:
 * there is no revision to pin, the lock makes a concurrent meal-planning create
 * impossible, and stating the two cases separately is what lets the update arm
 * carry a predicate the create arm cannot have.
 *
 * THE RESUME MARKER TRAVELS IN THE SAME STATEMENT, on the one save that earns
 * it: a manual confirmation standing on the manual route's own target stop
 * (`targets.logic.ts::resolveManualTargetSetupAdvance`). Written here rather
 * than as a second UPDATE because it is the same fact — the manual target
 * screen was completed — so the pinned revision that authorises the values must
 * authorise the marker too, and a refused write must leave setup exactly where
 * it stood. It is null on the create arm by construction: that arm runs because
 * there was no row, and a row that does not exist has no marker to advance.
 *
 * `meal_plan_preferences.revision` IS DELIBERATELY NOT BUMPED. That counter is
 * what a client pins when it writes preference ANSWERS, and this write changes
 * no answer — only the server-owned resume marker. Bumping it would refuse the
 * very next wizard step save on this exact route (Diet, the stop the marker now
 * names) with a spurious `409 stale_revision`. The client does not miss the new
 * marker either: the save-targets mutation invalidates the preferences query
 * (AAP §0.7.2), so it refetches and reads the advanced marker while the revision
 * it has pinned stays valid. `targets_revision` keeps its own increment, because
 * the targets record is what this save does change.
 */
const writeConfirmedTargets = async (
    locked: MealPlanningTransactionClient,
    userId: string,
    write: ConfirmedTargetsWrite,
): Promise<void> => {
    const record = {
        target_source: write.source,
        confirmed_targets: asSnapshotColumnValue(write.resolved.values),
        targets_input_revision: write.resolved.targetsInputRevision,
        // The estimate this confirmation was computed from, in the SAME
        // statement as the values it produced — so the record and the figure it
        // explains can never be half-written. `undefined` on a manual save,
        // which is retention rather than a clear, for the reason the docblock
        // above gives.
        estimated_targets: asStoredEstimateColumnValue(write.resolved.estimate),
    };

    if (!write.rowExists) {
        await locked.meal_plan_preferences.create({
            data: {
                user_id: userId,
                setup_status: NOT_STARTED_SETUP_STATUS,
                revision: FIRST_REVISION,
                targets_revision: write.storedRevision + 1,
                ...record,
            },
        });

        return;
    }

    const updated = await locked.meal_plan_preferences.updateMany({
        where: { user_id: userId, targets_revision: write.storedRevision },
        data: {
            // Incremented rather than assigned: one atomic statement, and the
            // predicate above has already established what it increments from.
            targets_revision: { increment: 1 },
            ...record,
            // Empty for every save that answers no setup stop, which leaves
            // both setup columns exactly as they stood — Prisma writes only the
            // keys it is given.
            ...(write.setupAdvance ?? {}),
        },
    });

    if (updated.count !== 1) {
        throw new StaleTargetsError(await readTargetsRevision(locked, userId));
    }
};

/**
 * `PUT /api/meal-planning/targets` — confirm the estimate, or store manual
 * values.
 *
 * The order inside the transaction is the write-safety model's (AAP §0.5.1),
 * and every step of it is load-bearing:
 *
 *  1. THE PER-USER LOCK FIRST. A target save is a mutating meal-planning
 *     transaction like any other, so it serialises against a generation that is
 *     reading the same targets. Without it, a plan could be built from targets
 *     halfway through being replaced.
 *  2. Re-read the preferences row under the lock. The revision checks below are
 *     only meaningful against a row nobody can change underneath them.
 *  3. THE TARGETS REVISION IS PINNED whenever the stored one is above 0. A
 *     mismatch — or a missing value once a revision exists — is
 *     `StaleTargetsError` carrying the authoritative revision, so the client can
 *     re-read, compare with its draft and resolve silently when the two already
 *     agree. A pinned value that does not match a stored 0 is refused for the
 *     same reason: the client pinned a revision that never existed.
 *  4. For `estimated`, recompute (see {@link resolveEstimatedValues}).
 *  5. Create or update the preferences row — and THE PINNED REVISION TRAVELS IN
 *     THE UPDATE'S OWN PREDICATE (see {@link writeConfirmedTargets}), because a
 *     check in TypeScript followed by an owner-only write is not an enforced
 *     revision (Rule `backend-architecture` §5.1, AAP §0.5.1). On the one save
 *     that stands on the manual route's target stop, THE SAME STATEMENT ALSO
 *     ADVANCES THE RESUME MARKER off `targets_manual`
 *     (`resolveManualTargetSetupAdvance`), and it belongs in this transaction
 *     for the same reason the snapshot does: the completed target screen and
 *     the values that completed it are one fact, so a refused or rolled-back
 *     write must leave setup exactly where it stood rather than resuming a user
 *     past a save that never landed. That stop exists on no other route and
 *     saves through no other endpoint (AAP §0.7.4), so nothing else can answer
 *     it. A legacy user editing targets from Account before any onboarding gets
 *     a row created with `setup_status: 'not_started'` and nothing else set —
 *     a target is not onboarding progress, so generation still answers
 *     `preferences_incomplete` until the wizard actually runs, and the advance
 *     is null on that arm by construction. `revision: 1` on creation, per
 *     §0.5.2, is what the client then pins on its first preference save; a save
 *     that advances the marker does NOT move `revision`, for the reason
 *     {@link writeConfirmedTargets} gives.
 *  6. Write `users.target_*` through `updateTargets(..., tx)` and record the
 *     snapshot, the source and the bumped revision — the pair that makes the
 *     canonical read truthful — together with `estimated_targets`, the account
 *     of the estimate an estimated confirmation was computed from (§0.5.1). A
 *     manual save leaves that last record standing rather than clearing it; see
 *     {@link writeConfirmedTargets}.
 *
 * INFEASIBLE-BUT-VALID TARGETS SUCCEED. `assessFeasibility` is advisory: its
 * warnings accompany a 200 and a stored value, and there is no 422 on this
 * route. The edit screen promises the macros need not add up; refusing them
 * would break that promise, and silently rebalancing them would break it worse.
 *
 * `now` is accepted so that a caller — the controller, or a test — can fix the
 * instant this write happens at, exactly as both preference saves do. Nothing
 * this transaction stores is derived from it today: the row carries no
 * confirmation timestamp, and `confirmed_targets` is defined as the four values
 * and nothing else, so adding one here would change a stored shape another
 * unit's read compares against.
 */
export const saveTargets = async (
    userId: string,
    body: unknown,
    now: Date = new Date(),
): Promise<SaveTargetsResult> => {
    const parsed = parseSaveTargetsRequest(body);

    if (parsed.kind !== 'ok') {
        return parsed;
    }

    const request = parsed.request;

    return prisma.$transaction((tx) =>
        withUserLock(tx, userId, async (locked) => {
            const row = await loadPreferencesRow(userId, locked);
            const storedRevision = row?.targets_revision ?? 0;
            const pinned = request.expectedTargetsRevision;

            if (pinned === null ? storedRevision > 0 : pinned !== storedRevision) {
                throw new StaleTargetsError(storedRevision);
            }

            const resolved: ResolvedTargetValues =
                request.source === 'estimated'
                    ? resolveEstimatedValues(row, request)
                    : // A manual save carries no calculated ancestry and no
                      // estimate: the user typed these four numbers. `estimate:
                      // null` leaves any previously stored estimate in place
                      // rather than clearing it (see `writeConfirmedTargets`).
                      { values: request.values, targetsInputRevision: null, estimate: null };

            await writeConfirmedTargets(locked, userId, {
                source: request.source,
                resolved,
                rowExists: row !== null,
                storedRevision,
                // The snapshot comes from `setupStateOf`, the one reading of
                // these columns, so this save cannot judge setup state by a
                // rule of its own; whether it moves is
                // `resolveManualTargetSetupAdvance`'s, and where to is
                // `nextSetupState`'s. The row is the one already read under the
                // lock, so the decision and the write see the same state.
                setupAdvance: resolveManualTargetSetupAdvance(
                    row === null ? null : setupStateOf(row),
                    request.source,
                ),
            });

            const written = await updateTargets(userId, resolved.values, locked);

            if (written === null) {
                // No `users` row for a verified caller: the account was never
                // created through POST /api/user. Thrown rather than returned,
                // so the transaction rolls back and NEITHER half of the write
                // lands — the preferences row must never claim a confirmed
                // target the users row does not hold. It gets no typed class in
                // `mealPlanning.errors.ts` because AAP §0.5.2 defines no code
                // for it on this route: inventing one would put a
                // machine-readable code on the wire that no client maps, so it
                // surfaces as the controller's 500, which is the honest answer
                // for an account that cannot exist on an authenticated request.
                throw new Error(`cannot write nutrition targets: no users row for ${userId}`);
            }

            const saved = await loadPreferencesRow(userId, locked);
            const userRow: TargetsUserRow = {
                target_calories: written.calories,
                target_protein_g: written.protein,
                target_carbs_g: written.carbs,
                target_fat_g: written.fat,
            };

            return {
                kind: 'ok',
                response: {
                    // Derived from what was actually stored, not from what was
                    // requested: `source` comes back `legacy` if the snapshot
                    // and the columns ever failed to agree, which is exactly the
                    // signal the client needs and one this service must not be
                    // able to paper over.
                    targets: deriveTargetsResponse(userRow, saved),
                    feasibility: assessFeasibility(resolved.values),
                },
            };
        }),
    );
};

/* ---------------------------------------------------------------------------
 * The planner's gate
 * ------------------------------------------------------------------------- */

/** The unset target fields, named so the client can ask for exactly those. */
const missingTargetFields = (targets: NutritionTargetValues | null): string[] =>
    targets === null ? [...TARGET_FIELDS] : TARGET_FIELDS.filter((field) => targets[field] === null);

/** The four confirmed targets a plan may be built from. */
export interface ConfirmedTargets {
    targets: MealPlanMacroTotals;
    targetsRevision: number;
}

/**
 * The verdict on a target read: the four confirmed values, or the typed reason a
 * plan may not be built from them.
 *
 * Pure, and shared by the locked gate and the unlocked preflight so the two can
 * never judge the same read differently — the preflight exists only to fail a
 * hopeless request before a five-second search, and it would be worse than
 * useless if it applied a different rule from the authoritative check.
 *
 * The three outcomes, in the order they are judged:
 *
 *  * Nothing set, or not all four set -> `TargetsMissingError` naming the unset
 *    fields (422). The planner needs all four; a calories-only legacy account
 *    cannot be planned for.
 *  * `source === 'legacy'` -> `TargetsUnconfirmedError` (409). The values are
 *    complete but were last written from outside this feature, so nobody
 *    confirmed them HERE and presenting the resulting plan as reviewed would be
 *    untrue.
 *  * Otherwise the four values and the revision they were confirmed at, which
 *    the plan stores as its `targets_revision` snapshot.
 *
 * `complete` already guarantees the four values are non-null; they are re-checked
 * because that guarantee is a runtime one and this function's return type is
 * all-number. The re-check cannot fire, and if it ever did, failing loudly is
 * the only alternative to inventing a target.
 */
const judgeConfirmedTargets = (response: TargetsResponse): ConfirmedTargets => {
    if (response.targets === null || !response.complete) {
        throw new TargetsMissingError(missingTargetFields(response.targets));
    }

    if (response.source === 'legacy') {
        throw new TargetsUnconfirmedError();
    }

    const { calories, protein, carbs, fat } = response.targets;

    if (calories === null || protein === null || carbs === null || fat === null) {
        throw new TargetsMissingError(missingTargetFields(response.targets));
    }

    return {
        targets: { calories, protein, carbs, fat },
        targetsRevision: response.revision,
    };
};

/**
 * The confirmed targets a plan may be built from, read under the OWNING USER
 * ROW'S LOCK and held there until the transaction commits.
 *
 * THIS IS WHAT STOPS A WEEK BEING BUILT ON NUMBERS NOBODY CONFIRMED (AAP
 * §0.5.1), and the lock is the half of it that the advisory lock cannot supply.
 * `PUT /api/user/targets` stays untouched for API compatibility and writes
 * `users.target_*` WITHOUT taking the per-user advisory lock, so that lock
 * serialises this feature's own writes and nothing else. Two separate hazards
 * follow, and both are closed here:
 *
 *  1. AN INCOHERENT PAIR. `deriveTargetsResponse`'s verdict compares the four
 *     `users` columns with `confirmed_targets`. Read as two statements the
 *     legacy write can land between them, and the pair then agrees with itself
 *     while the committed value has already moved. `readStoredTargets` reads
 *     both rows in one statement, so that reading cannot be assembled.
 *  2. A WRITE AFTER THE CHECK. Even a coherent pair says nothing about the
 *     instant after it was read, and the plan is inserted later in the same
 *     transaction. `SELECT … FOR UPDATE OF u` takes the row lock the legacy
 *     writer's own UPDATE must wait for, and an advisory-transaction lock is
 *     released only at COMMIT or ROLLBACK — so from this call until the plan is
 *     published, the confirmed pair this gate judged IS the committed pair.
 *     `meal_plans.targets_snapshot` therefore cannot differ from
 *     `confirmed_targets` at the moment it commits.
 *
 * A legacy write that landed BEFORE this read is seen by it: the values no
 * longer match the snapshot, the source resolves to `legacy`, and the caller
 * gets `409 targets_unconfirmed` instead of a plan. One that arrives after is
 * blocked until this transaction ends and then applies to a plan that was built
 * on values which were confirmed when it was built — the two orderings AAP
 * §0.9.2 requires, with nothing in between.
 *
 * `tx` is `MealPlanningTransactionClient`, so the global client is a COMPILE
 * ERROR rather than a comment asking callers not to pass it: on the autocommit
 * client the row lock would be released the moment its own statement returned
 * and hazard 2 would be wide open again while this code looked unchanged. A
 * caller that only wants to fail fast before searching uses
 * {@link previewConfirmedTargets} instead, and says so.
 */
export const requireConfirmedTargets = async (
    tx: MealPlanningTransactionClient,
    userId: string,
): Promise<ConfirmedTargets> => {
    const { user, preferences } = await readStoredTargets(userId, tx, 'locked_for_write');

    return judgeConfirmedTargets(deriveTargetsResponse(user, preferences));
};

/**
 * The same verdict, read WITHOUT the row lock and outside any transaction.
 *
 * ADVISORY ONLY, and never the basis of a publication. It exists so that a
 * request which cannot possibly produce a plan — no targets, or targets nobody
 * confirmed — is refused before the generator spends up to five seconds
 * searching a week that could never be published. The authoritative check is
 * {@link requireConfirmedTargets}, which runs inside the transaction under the
 * per-user advisory lock and the users-row lock; whatever this one returns is
 * re-judged there before anything is written.
 *
 * The read is still a single statement, so the values it returns are a coherent
 * pair rather than two rows from different instants — a candidate week searched
 * against a self-inconsistent pair would be discarded by the locked gate
 * anyway, but there is no reason to search it.
 */
export const previewConfirmedTargets = async (
    userId: string,
    db: Prisma.TransactionClient = prisma,
): Promise<ConfirmedTargets> => judgeConfirmedTargets(await getTargets(userId, db));
