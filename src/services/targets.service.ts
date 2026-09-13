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
// records `confirmed_targets`, `target_source` and `targets_revision + 1` on
// `meal_plan_preferences`, which is what makes the canonical read able to tell a
// confirmed target from a legacy one at all: the legacy route never bumps the
// revision and leaves no other trace, so the snapshot written here is the only
// record of what was confirmed. Both halves must commit or neither, or a
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
    InvalidRequestDetail,
    MealPlanMacroTotals,
    NutritionTargetValues,
    SaveTargetsResponse,
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
import { withUserLock } from './mealPlanningAction.service';
import { updateTargets } from './nutrition.service';
import { PREFERENCE_FIELD_CODES } from './preferences.logic';
import { PreferencesRow, loadPreferencesRow } from './preferences.service';
import {
    MANUAL_TARGET_FIELD_CODES,
    TargetsUserRow,
    assessFeasibility,
    computeTargetEstimate,
    deriveTargetsResponse,
    parseManualTargets,
    resolveEstimateInputs,
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
 * The stored targets of one user.
 *
 * `where: {id: userId}` IS the owner key (§5.1) — the primary key of the owning
 * row — so this read is user-scoped by construction. The four columns are
 * projected explicitly because nothing else about the user belongs in a target
 * response.
 */
const loadStoredTargets = async (
    userId: string,
    db: Prisma.TransactionClient,
): Promise<TargetsUserRow> => {
    const user = await db.users.findUnique({
        where: { id: userId },
        select: {
            target_calories: true,
            target_protein_g: true,
            target_carbs_g: true,
            target_fat_g: true,
        },
    });

    return user ?? NO_STORED_TARGETS;
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
 * The two reads are sequential because `db` may be an interactive transaction
 * client — generation calls this under the per-user lock through
 * {@link requireConfirmedTargets} — and that client is a single connection.
 */
export const getTargets = async (
    userId: string,
    db: Prisma.TransactionClient = prisma,
): Promise<TargetsResponse> => {
    const userRow = await loadStoredTargets(userId, db);
    const preferencesRow = await loadPreferencesRow(userId, db);

    return deriveTargetsResponse(userRow, preferencesRow);
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
 * THIS PARSER BELONGS IN `targets.logic.ts` AND IS HERE ONLY BECAUSE THAT FILE
 * IS ANOTHER UNIT'S AT THIS CHECKPOINT. It is written the way every parser in
 * that layer is written — pure, synchronous, returning a verdict rather than
 * throwing, reporting every offending field in one answer — so moving it is a
 * cut and paste with no behavioural change. `parseManualTargets` already owns
 * the four manual VALUES and is called rather than re-implemented; what is added
 * here is only the envelope around them: which of the two shapes was sent, the
 * estimate revision the estimated shape pins, and the targets revision both
 * shapes pin.
 * ------------------------------------------------------------------------- */

/** The two sources the envelope may declare, as a closed set keyed off the DTO union. */
const TARGET_SOURCES: Readonly<Record<TargetRoute, true>> = { estimated: true, manual: true };

/** Confirming the server-calculated estimate: the client never sends the numbers. */
interface EstimatedSaveRequest {
    source: 'estimated';
    /** The preferences revision the displayed estimate was computed from. */
    estimateRevision: number;
    /** null when the body pinned no targets revision, which is legal only before the first save. */
    expectedTargetsRevision: number | null;
}

/** Hand-entered targets, stored exactly as given. */
interface ManualSaveRequest {
    source: 'manual';
    values: MealPlanMacroTotals;
    expectedTargetsRevision: number | null;
}

type SaveTargetsRequest = EstimatedSaveRequest | ManualSaveRequest;

/** The refusal shape both this parser and {@link SaveTargetsResult} carry. */
interface TargetsErrorVerdict {
    kind: 'error';
    code: 'invalid_request';
    message: string;
    details: InvalidRequestDetail[];
}

type ParsedSaveTargets = { kind: 'ok'; request: SaveTargetsRequest } | TargetsErrorVerdict;

const invalidRequest = (details: InvalidRequestDetail[]): TargetsErrorVerdict => ({
    kind: 'error',
    code: 'invalid_request',
    // A server-side diagnostic naming every offending field, in the same shape
    // `targets.logic.ts::parseManualTargets` produces. The client renders
    // `details`, never this string.
    message: `invalid targets request: ${details
        .map((detail) => `${detail.field} (${detail.code})`)
        .join(', ')}`,
    details,
});

const asRecord = (value: unknown): Record<string, unknown> | null =>
    typeof value === 'object' && value !== null && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : null;

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
 * One optional revision field: absent, or a whole number that is not negative.
 *
 * Absent is reported as `null` rather than as a failure, because "no revision
 * pinned" is legal before the first save; whether it is legal THIS time depends
 * on the stored revision, which no pure parser can know, so that half of the
 * rule is applied under the lock in {@link saveTargets}.
 */
const parseOptionalRevision = (
    value: unknown,
    field: string,
): { revision: number | null } | InvalidRequestDetail => {
    if (value === undefined || value === null) {
        return { revision: null };
    }

    if (typeof value !== 'number' || !Number.isFinite(value)) {
        return { field, code: MANUAL_TARGET_FIELD_CODES.INVALID_TYPE };
    }

    if (!Number.isInteger(value)) {
        return { field, code: MANUAL_TARGET_FIELD_CODES.NOT_AN_INTEGER };
    }

    if (value < 0) {
        return { field, code: MANUAL_TARGET_FIELD_CODES.BELOW_MINIMUM };
    }

    return { revision: value };
};

/** The same field, required — the estimated shape cannot be judged without it. */
const parseRequiredRevision = (value: unknown, field: string): number | InvalidRequestDetail => {
    if (value === undefined || value === null) {
        return { field, code: MANUAL_TARGET_FIELD_CODES.REQUIRED };
    }

    const parsed = parseOptionalRevision(value, field);

    return 'revision' in parsed ? (parsed.revision as number) : parsed;
};

/**
 * Validates the save envelope and reports every problem in one verdict.
 *
 * `source` is judged first and alone when it is unusable: the two shapes have
 * different required fields, so reporting "calories is required" for a body
 * whose `source` is misspelled would describe a shape the client never meant to
 * send.
 */
const parseSaveTargetsRequest = (body: unknown): ParsedSaveTargets => {
    const record = asRecord(body);

    if (record === null) {
        return invalidRequest([{ field: 'body', code: MANUAL_TARGET_FIELD_CODES.INVALID_TYPE }]);
    }

    const source = record.source;

    if (source === undefined || source === null) {
        return invalidRequest([{ field: 'source', code: MANUAL_TARGET_FIELD_CODES.REQUIRED }]);
    }

    if (typeof source !== 'string' || !Object.prototype.hasOwnProperty.call(TARGET_SOURCES, source)) {
        // The same spelling every other parser in this feature uses for a value
        // outside a closed set, imported rather than restated so the client maps
        // one code.
        return invalidRequest([{ field: 'source', code: PREFERENCE_FIELD_CODES.UNKNOWN_VALUE }]);
    }

    const details: InvalidRequestDetail[] = [];
    const expected = parseOptionalRevision(record.expectedTargetsRevision, 'expectedTargetsRevision');

    if (!('revision' in expected)) {
        details.push(expected);
    }

    if (source === 'manual') {
        const values = parseManualTargets(record);

        if (values.kind !== 'valid') {
            details.push(...values.details);
        }

        if (details.length > 0 || values.kind !== 'valid') {
            return invalidRequest(details);
        }

        return {
            kind: 'ok',
            request: {
                source: 'manual',
                values: values.values,
                expectedTargetsRevision: (expected as { revision: number | null }).revision,
            },
        };
    }

    const estimateRevision = parseRequiredRevision(record.estimateRevision, 'estimateRevision');

    if (typeof estimateRevision !== 'number') {
        details.push(estimateRevision);
    }

    if (details.length > 0 || typeof estimateRevision !== 'number') {
        return invalidRequest(details);
    }

    return {
        kind: 'ok',
        request: {
            source: 'estimated',
            estimateRevision,
            expectedTargetsRevision: (expected as { revision: number | null }).revision,
        },
    };
};

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
 * The values a save will store, and the estimate input revision that produced
 * them.
 *
 * `targetsInputRevision` is non-null only for a confirmed ESTIMATE: it is the
 * preferences revision whose goal, body, activity and pace produced the figure,
 * and `TargetsResponse.stale` is exactly its inequality with the current
 * revision. Manual targets carry null, because the user typed them and a later
 * change of inputs says nothing about them — leaving a previous estimate's input
 * revision behind would make a manual target claim an ancestry it does not have.
 */
interface ResolvedTargetValues {
    values: MealPlanMacroTotals;
    targetsInputRevision: number | null;
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
 * Availability is checked BEFORE staleness: `prefer_not_to_say` and missing
 * measurements route the user to manual entry, which is a different destination
 * from "recalculate and confirm again", and the more fundamental fork should be
 * the one reported.
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
        targetsInputRevision: row.revision,
    };
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
 *  5. UPSERT the preferences row. A legacy user editing targets from Account
 *     before any onboarding gets a row with `setup_status: 'not_started'` and
 *     nothing else set — a target is not onboarding progress, so generation
 *     still answers `preferences_incomplete` until the wizard actually runs.
 *     `revision: 1` on creation, per §0.5.2, is what the client then pins on its
 *     first preference save.
 *  6. Write `users.target_*` through `updateTargets(..., tx)` and record the
 *     snapshot, the source and the bumped revision — the pair that makes the
 *     canonical read truthful.
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

            const resolved =
                request.source === 'estimated'
                    ? resolveEstimatedValues(row, request)
                    : { values: request.values, targetsInputRevision: null };

            await locked.meal_plan_preferences.upsert({
                where: { user_id: userId },
                create: {
                    user_id: userId,
                    setup_status: NOT_STARTED_SETUP_STATUS,
                    revision: FIRST_REVISION,
                    target_source: request.source,
                    targets_revision: storedRevision + 1,
                    confirmed_targets: asSnapshotColumnValue(resolved.values),
                    targets_input_revision: resolved.targetsInputRevision,
                },
                update: {
                    target_source: request.source,
                    // Incremented rather than assigned: one atomic statement,
                    // and the lock has already established what it increments
                    // from.
                    targets_revision: { increment: 1 },
                    confirmed_targets: asSnapshotColumnValue(resolved.values),
                    targets_input_revision: resolved.targetsInputRevision,
                },
            });

            const written = await updateTargets(userId, resolved.values, locked);

            if (written === null) {
                // No `users` row for a verified caller: the account was never
                // created through POST /api/user. Thrown rather than returned,
                // so the transaction rolls back and NEITHER half of the write
                // lands — the preferences row must never claim a confirmed
                // target the users row does not hold. There is no error class
                // for it in the shared vocabulary (`mealPlanning.errors.ts`
                // belongs to another unit at this checkpoint), so this surfaces
                // as the controller's 500 rather than the legacy route's 404.
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

/**
 * The four confirmed targets a plan may be built from, or the reason it may not
 * be.
 *
 * THIS IS WHAT STOPS A WEEK BEING BUILT ON NUMBERS NOBODY CONFIRMED, and it runs
 * inside the caller's transaction on purpose: generation takes the per-user lock
 * and then re-reads the targets, so a legacy `PUT /api/user/targets` that slipped
 * in between the user's confirmation and the publication is caught here as
 * `targets_unconfirmed` rather than becoming a plan built on unconfirmed values
 * (AAP §0.5.1). `tx` is therefore required, not defaulted: a `prisma`-shaped
 * default would read outside the lock and silently give that up.
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
export const requireConfirmedTargets = async (
    tx: Prisma.TransactionClient,
    userId: string,
): Promise<{ targets: MealPlanMacroTotals; targetsRevision: number }> => {
    const response = await getTargets(userId, tx);

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
