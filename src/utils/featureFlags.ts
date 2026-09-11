/**
 * The two server-side meal-planning switches. Both are read once, at import,
 * and are reachable only through the accessors below — so a controller or
 * service asks this module rather than reading the environment itself.
 *
 * Scope is deliberately these two variables and nothing else: the catalog
 * pipeline's model-call budget belongs to `scripts/lib/budget.ts` and the
 * evidence fetch timeout to `evidence.service.ts`.
 */

/** Fault injection for reaching the failure states in development and test. */
export type MealPlanningFault = 'off' | 'generation' | 'swap' | 'log';

/**
 * The idempotency-keyed writes — the values of `meal_plan_actions.action_type`.
 *
 * Declared here rather than imported from `src/types/mealPlanning.ts`: that
 * module arrives later than this one, and a leaf with no imports must not
 * invert that order. Unions are structural, so a caller passing its own
 * `'log'` type-checks against this one without depending on it.
 */
export type MealPlanningActionType = 'generate' | 'regenerate' | 'swap' | 'log';

/**
 * Header that asks a handler to drop the response once its transaction has
 * committed, so a test can exercise a lost response over a durable write.
 * Exported so the controller and the suite share one spelling of it.
 */
export const POST_COMMIT_ABORT_HEADER = 'x-test-abort-after-commit';

const MEAL_PLANNING_FAULTS: readonly MealPlanningFault[] = ['off', 'generation', 'swap', 'log'];

export class FeatureFlagError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'FeatureFlagError';
    }
}

/**
 * Production is checked *before* the value is validated, and that order is the
 * load-bearing line in this file: in production a stray or misspelled
 * `MEAL_PLANNING_FAULT` is ignored, never rejected, because failing startup
 * over a development-only switch would take the service down. Everywhere else
 * an unrecognised value fails loudly instead of being silently coerced to a
 * working default that hides the typo.
 */
const resolveFault = (
    rawFault: string | undefined,
    isProductionEnv: boolean,
): MealPlanningFault => {
    if (isProductionEnv) {
        return 'off';
    }
    if (rawFault === undefined || rawFault === '') {
        return 'off';
    }

    const allowed = MEAL_PLANNING_FAULTS.find((candidate) => candidate === rawFault);
    if (allowed !== undefined) {
        return allowed;
    }

    throw new FeatureFlagError(
        `MEAL_PLANNING_FAULT must be one of ${MEAL_PLANNING_FAULTS.join(' | ')}; received "${rawFault}"`,
    );
};

// Read once, at import.
//
// `MEAL_PLANNING_ENABLED` is an opt-in matched against the exact string
// 'true', so absent, blank and misspelled all mean off. That polarity is the
// deliberate inverse of AI_FEATURES_ENABLED in entitlement.service.ts, which
// disables only on exactly 'false' — do not "correct" it to match: a release
// boots these routes answering 503 and turns planning on only once the catalog
// and recipes have been loaded and verified.
const mealPlanningEnabled = process.env.MEAL_PLANNING_ENABLED === 'true';
// One snapshot of NODE_ENV, and both environment booleans derive from it: two
// reads of a mutable global could disagree, and a value that is somehow both
// production and test would put the fault resolver and the abort predicate on
// different footings.
const nodeEnv = process.env.NODE_ENV;
const isProduction = nodeEnv === 'production';
const isTest = nodeEnv === 'test';
const resolvedFault = resolveFault(process.env.MEAL_PLANNING_FAULT, isProduction);

export function isMealPlanningEnabled(): boolean {
    return mealPlanningEnabled;
}

export function mealPlanningFault(): MealPlanningFault {
    return resolvedFault;
}

/**
 * Whether a keyed write should drop its response after committing. This
 * answers with a boolean and nothing else — destroying the socket, like every
 * other choice about the response, belongs to the controller.
 */
export function postCommitAbort(
    actionType: MealPlanningActionType,
    headerValue: unknown,
): boolean {
    // Not gated on NODE_ENV by design: this is the path a developer drives from
    // a device against a dev backend, and it is already inert in production
    // because the resolver forces the fault to 'off' there.
    if (resolvedFault === 'log' && actionType === 'log') {
        return true;
    }

    // The header is a test-only affordance, so it is never read outside a test
    // run — a request cannot reach it in development or production.
    if (!isTest) {
        return false;
    }

    // `unknown` keeps Express out of this module: `req.header()` yields
    // `string | undefined`, and a repeated header can yield an array.
    return typeof headerValue === 'string' && headerValue.trim() === actionType;
}
