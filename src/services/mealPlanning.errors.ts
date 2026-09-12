// The typed-error vocabulary for meal planning. Every meal-planning service
// throws from this file, and the two controllers that sit in front of them
// (mealPlanning.controller, catalog.controller) are the only places that turn
// one of these classes into an HTTP status. That split is the reason nothing
// here knows a status code: a service that picked one would be speaking HTTP
// from the wrong layer (backend-architecture §8).
//
// Each class carries the DATA the client acts on rather than a message it would
// have to parse, and the payload types come from types/mealPlanning.ts so the
// error and the response body it serializes into cannot drift apart. The eight
// classes whose payload has a declared wire shape say `implements` for exactly
// that reason: it is a compile-time-only check, so a change to the wire data
// breaks the build here instead of silently shipping a body the client cannot
// decode.
//
// Two things deliberately live elsewhere. Vendor and utility failures belong to
// the module that raises them — EstimateFailedError (estimate.service),
// OpenRouterError (openrouter.service), UsdaError (usda.service),
// UnitConversionError (utils/units), FeatureFlagError (utils/featureFlags) —
// and are not re-exported here, because a barrel would rebuild the coupling
// those boundaries exist to prevent (§9). Field-level validation has no class
// at all: the pure parsers in the *.logic.ts modules return their verdict as
// InvalidRequestDetail entries rather than throwing, which is what keeps them
// testable without exceptions.
//
// This file holds class declarations only — no parsing, no derivation, no
// Prisma, and no import that survives compilation (§7.1, §12).

import type {
    EstimateUnavailableErrorData,
    LimitingConstraint,
    NoMatchingMealsErrorData,
    PlanEndedErrorData,
    PlanOverlapErrorData,
    PlanSupersededErrorData,
    StalePlanErrorData,
    StaleRevisionErrorData,
    StaleTargetsErrorData,
    TargetsMissingErrorData,
} from '../types/mealPlanning';

/* ---------------------------------------------------------------------------
 * Preferences and setup
 * ------------------------------------------------------------------------- */

// Generation was asked for before the answers it needs exist: setup has not
// reached 'ready_for_review' or 'completed'. The client resumes onboarding from
// the step the preferences response reports, so the error itself carries none.
export class PreferencesIncompleteError extends Error {
    constructor() {
        super('Meal plan setup is not complete');
        this.name = 'PreferencesIncompleteError';
    }
}

// Both inputs a plan is pinned to are reported, because either may have moved
// and the client re-runs from whichever is fresh. The preference routes pin one
// counter instead and answer StaleRevisionCounterErrorData; their controller
// derives that body from `preferencesRevision`, so one class covers both forms
// of the single stale_revision code rather than a near-duplicate class.
export class StaleRevisionError extends Error implements StaleRevisionErrorData {
    constructor(
        public readonly preferencesRevision: number,
        public readonly targetsRevision: number,
    ) {
        super('Preferences or targets changed since this request was prepared');
        this.name = 'StaleRevisionError';
    }
}

// A preferences body carried a server-owned or unknown key. The field name is
// client-supplied, so it travels as data and never as message text; the
// controller renders it as the InvalidRequestDetail whose code is
// 'read_only_field'.
export class ReadOnlyFieldError extends Error {
    constructor(public readonly field: string) {
        super('Request contains a read-only field');
        this.name = 'ReadOnlyFieldError';
    }
}

/* ---------------------------------------------------------------------------
 * Targets
 * ------------------------------------------------------------------------- */

// Not a failure so much as a fork: 'prefer_not_to_say' is an answer that cannot
// be calculated from, and 'missing_inputs' means the measurements are not in
// yet. The reason is what sends the user to manual target entry rather than to
// an error, which is why it is typed against the wire union instead of a string.
export class EstimateUnavailableError extends Error implements EstimateUnavailableErrorData {
    constructor(public readonly reason: EstimateUnavailableErrorData['reason']) {
        super('Target estimate is unavailable for these answers');
        this.name = 'EstimateUnavailableError';
    }
}

// The client offered an estimate revision that no longer matches the answers on
// record, so the numbers on screen were calculated from inputs that have since
// changed. Confirming them would store a figure the user never reviewed.
export class EstimateStaleError extends Error {
    constructor() {
        super('Target estimate is out of date');
        this.name = 'EstimateStaleError';
    }
}

// The authoritative revision travels back so the client can re-read, compare
// against its own draft, and resolve silently when the two already agree.
export class StaleTargetsError extends Error implements StaleTargetsErrorData {
    constructor(public readonly currentRevision: number) {
        super('Nutrition targets changed since this request was prepared');
        this.name = 'StaleTargetsError';
    }
}

// The planner needs all four values. Naming the unset ones lets the client ask
// for exactly those instead of re-running the whole review screen.
export class TargetsMissingError extends Error implements TargetsMissingErrorData {
    constructor(public readonly missing: string[]) {
        super('Nutrition targets are incomplete');
        this.name = 'TargetsMissingError';
    }
}

// The stored targets are complete but were last written from outside this
// feature, so nobody confirmed them here. Building a week on them would present
// unreviewed numbers as a reviewed plan.
export class TargetsUnconfirmedError extends Error {
    constructor() {
        super('Nutrition targets have not been confirmed');
        this.name = 'TargetsUnconfirmedError';
    }
}

/* ---------------------------------------------------------------------------
 * Plan lifecycle and keyed writes
 * ------------------------------------------------------------------------- */

// The requested week collides with a plan that already covers those dates. The
// colliding plan's id is what lets the client open it instead of guessing.
export class PlanOverlapError extends Error implements PlanOverlapErrorData {
    constructor(public readonly conflictingPlanId: string) {
        super('Requested week overlaps an existing plan');
        this.name = 'PlanOverlapError';
    }
}

// At most one plan may start after today, and one already does. The client
// reaches it through the current-plan response, so no id is carried here.
export class UpcomingExistsError extends Error {
    constructor() {
        super('An upcoming plan already exists');
        this.name = 'UpcomingExistsError';
    }
}

// The plan moved under a screen holding an older revision. The current revision
// comes back so the client can refetch at it and retry the same intent.
export class StalePlanError extends Error implements StalePlanErrorData {
    constructor(public readonly currentRevision: number) {
        super('Plan changed since this request was prepared');
        this.name = 'StalePlanError';
    }
}

// The two ways a plan stops accepting writes supply different halves of the
// answer, so both members are optional and exactly one is passed:
//   superseded by a regeneration -> new PlanNotActiveError(replacementPlanId)
//   its last date has passed     -> new PlanNotActiveError(undefined, 'ended')
// `implements PlanNotActiveErrorData` is impossible because that type is a
// union and a class may only implement an object type with statically known
// members; indexing the two halves keeps both members tied to the wire shape
// anyway, which is the drift protection that mattered.
export class PlanNotActiveError extends Error {
    constructor(
        public readonly replacementPlanId?: PlanSupersededErrorData['replacementPlanId'],
        public readonly reason?: PlanEndedErrorData['reason'],
    ) {
        super('Plan is no longer active');
        this.name = 'PlanNotActiveError';
    }
}

// The key has been seen before with a different request fingerprint, so this is
// a genuinely different write wearing a used key — never a retry. A matching
// fingerprint replays the stored response instead of reaching this class.
export class IdempotencyConflictError extends Error {
    constructor() {
        super('Idempotency key was used with a different request');
        this.name = 'IdempotencyConflictError';
    }
}

// A feasibility verdict, not a server failure: the search finished and no week
// satisfies these preferences. The constraints are ordered most-limiting first
// and each names the setup step that would open the week up again.
export class NoMatchingMealsError extends Error implements NoMatchingMealsErrorData {
    // Owned by the error rather than added by the controller: allergies are
    // never relaxed to find more meals, so the promise is an invariant of the
    // failure itself and no response can be shaped without it.
    public readonly allergiesKept: true = true;

    constructor(public readonly limitingConstraints: LimitingConstraint[]) {
        super('No meals match these preferences');
        this.name = 'NoMatchingMealsError';
    }
}

// The search could not complete — distinct from NoMatchingMealsError, which is
// a completed search reporting infeasibility. Nothing was persisted, so any
// plan the user already had is still theirs.
export class PlanGenerationError extends Error {
    constructor() {
        super('Plan generation failed');
        this.name = 'PlanGenerationError';
    }
}

/* ---------------------------------------------------------------------------
 * Swaps
 * ------------------------------------------------------------------------- */

// The portion recomputed at commit time differs from the one the preview showed,
// so committing would swap in an amount the user never saw. The client refreshes
// the preview, which mints a new intent.
export class PreviewStaleError extends Error {
    constructor() {
        super('Swap preview is out of date');
        this.name = 'PreviewStaleError';
    }
}

// The candidate no longer passes eligibility for this slot — a recipe retired,
// or a preference change ruled it out between listing and committing.
export class RecipeIneligibleError extends Error {
    constructor() {
        super('Recipe is not eligible for this meal');
        this.name = 'RecipeIneligibleError';
    }
}

// The commit failed and nothing was written: the original meal stands and the
// grocery list was not touched. That is the assurance the client shows, so this
// class is thrown only when it is actually true.
export class SwapFailedError extends Error {
    constructor() {
        super('Meal swap failed');
        this.name = 'SwapFailedError';
    }
}

/* ---------------------------------------------------------------------------
 * Resource visibility
 *
 * One class per resource, carrying nothing. "No such plan" and "not your plan"
 * must be indistinguishable to the caller, and a discriminator — even an
 * internal one — is how that leaks (§8).
 * ------------------------------------------------------------------------- */

export class PlanNotFoundError extends Error {
    constructor() {
        super('Meal plan not found');
        this.name = 'PlanNotFoundError';
    }
}

export class CatalogFoodNotFoundError extends Error {
    constructor() {
        super('Catalog food not found');
        this.name = 'CatalogFoodNotFoundError';
    }
}

/* ---------------------------------------------------------------------------
 * Capability
 * ------------------------------------------------------------------------- */

// The server-side kill switch is off. Thrown by the gated routes only: the
// target routes and the catalog search stay available, because surfaces outside
// meal planning depend on them.
export class MealPlanningDisabledError extends Error {
    constructor() {
        super('Meal planning is not available');
        this.name = 'MealPlanningDisabledError';
    }
}
