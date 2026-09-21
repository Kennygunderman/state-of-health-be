// The HTTP suite for the three preference endpoints — the first user-scoped
// meal-planning resource, and therefore the file that fixes how the revision
// protocol, the persisted setup state machine and the `503 feature_disabled`
// gate are asserted for every later suite (Agent Action Plan §0.5.2's three
// `…/preferences*` rows, §0.5.1's flag lifecycle, §0.9.2's preferences rows).
// `mealPlanning.routes.ts` names this suite as one of its verifiers.
//
//   GET /api/meal-planning/preferences
//   PUT /api/meal-planning/preferences/steps/:step
//   PUT /api/meal-planning/preferences
//
// WHAT IS PROVEN HERE, AND WHY A UNIT TEST CANNOT DO IT.
//
// 1. THE WIRING. Every rule these endpoints apply is pure and already unit
//    tested with no database in `src/services/__tests__/preferences.logic.test.ts`
//    — the step parsers' field verdicts, the state machine's transition table,
//    allergen exclusivity, the unit normalisation, the budget tier, the food
//    group derivation, `normalizeTimeZone` and `evaluateMealAgainstPreferences`.
//    None of that establishes that a REQUEST reaches them, that the router sits
//    behind the auth boundary, or that a verdict becomes the status code and
//    body the client decodes. So every case below drives the shipped app
//    through `request` from `../setup/testApp` — the real mount order, the real
//    controller, the real service, a real PostgreSQL — and asserts the status,
//    the machine code and the stored rows.
//
// 2. THE REVISION PROTOCOL, WHOSE ASYMMETRY IS THE MOST LIKELY THING TO BE
//    IMPLEMENTED WRONG. `expectedRevision` is optional ONLY for the very first
//    `goal` save, which is the one that creates the row and has no revision to
//    pin, and is required and exact from then on (§0.5.2). That reads like an
//    inconsistency until you see that a client cannot know a revision for a row
//    that does not exist, so all four combinations are covered — absent before
//    creation, absent after, wrong after, exact after — and each refusal is
//    asserted to have written NOTHING.
//
// 3. THE STATE MACHINE AS STORED. `nextSetupState` is monotonic, but "a
//    completed user editing one answer from plan settings is not sent back into
//    onboarding" is a property of that function TOGETHER with the writer that
//    persists its output. Only a real save can show the status column standing
//    still while the answer underneath it changes.
//
// 4. THE FLAG LIFECYCLE, which exists nowhere else. A preference save
//    recomputes `meal_plan_meals.flags` for every active, unended plan inside
//    the SAME transaction, bumps `meal_plans.revision` only where a verdict
//    actually changed, and reports the total as `affectedMealCount` (§0.5.1,
//    §0.7.3). It is the one write to an active plan that carries no idempotency
//    key, so there is no ledger row to look for and none is sought. Both
//    endpoints are driven through the same incompatibility and required to
//    produce identical flag state, because two paths through one lifecycle is
//    how they come to disagree. That lifecycle is also where the save's
//    ATOMICITY becomes provable: a failure injected into the recomputation —
//    after the preference row and a meal's flags have been written — is the
//    only way to show that a save which cannot finish leaves nothing behind,
//    and it too is driven through both endpoints.
//
// 5. THE GATE IS PER HANDLER, NOT PER ROUTER. With `MEAL_PLANNING_ENABLED` off
//    all three preference routes answer `503 feature_disabled` while
//    `GET /meal-planning/targets`, mounted in the same router, still answers
//    200 — Account, Progress and the diary's target editor depend on it
//    (§0.3.1, §0.5.2). One assertion of the contrast proves the shape of the
//    gate; the depth of the targets contract belongs to `api/targets.test.ts`.
//
// ASSERTED IN BOTH DIRECTIONS, so nothing passes by being constant: a save
// must flag the meals AND saving the preference back must clear them; the gate
// must refuse with the flag off AND answer with it on; a zone alias must be
// canonicalised AND the runtime must be shown to spell it differently first; a
// recompute must bump the plan revision when a verdict moves AND leave it alone
// when none does.
//
// WHAT IS DELIBERATELY NOT HERE. `api/requestParserWiring.test.ts` owns "the
// parse happens before any I/O" for both saves, against a recording Prisma
// stub; the read-only-field cases below assert the HTTP STATUS AND BODY that
// verdict becomes, which is the controller's claim rather than the service's.
// `api/concurrency.test.ts` owns the two-client race at the service level; the
// race below is driven over HTTP on the step endpoint. `api/targets.test.ts`
// owns target truth and staleness.
//
// NO 403 AND NO 404 APPEAR IN THIS FILE, and their absence is the contract
// rather than an omission: a preferences row is addressed by the verified token
// alone (`getUserId(req)`), so there is no id class a caller could present to
// reach another user's row and nothing for an existence oracle to leak. What
// tenancy means here is asserted directly instead — one user's save leaves the
// other's row byte-identical, and a body that names a user id is refused rather
// than silently ignored.
//
// DETERMINISM. Every value is stated; the only clock reading is
// `utcTodayDayKey()`, used for the review step's start date and for the plan
// fixtures whose lifecycle is defined relative to today (a pinned week would
// quietly become an ended plan). Zones are `America/New_York` (behind UTC) so
// the UTC day key is always inside the start-date window the server computes in
// the user's own zone.

import type { meal_plan_meals, meal_plan_preferences, meal_plans } from '../../generated/prisma';
import { prisma } from '../../prisma/client';
import { ReadOnlyFieldError } from '../../services/mealPlanning.errors';
import { NO_PREFERENCES_REVISION, PREFERENCE_FIELD_CODES } from '../../services/preferences.logic';
// The namespace form, beside the named imports above, because one case spies on
// the module's `evaluateMealAgainstPreferences` export to inject a failure
// inside the flag recomputation — the same instrument `api/targets.test.ts`
// uses on `grocery.service.ts` to hold a publication transaction open.
import * as preferencesLogic from '../../services/preferences.logic';
// Likewise: the recipe read is the cross-module call that opens each active
// plan's recomputation, and spying on it is how one case fails a save AFTER a
// whole plan — audit record included — has been recomputed.
import * as recipeService from '../../services/recipe.service';
// The two service entry points, called directly by the cases that assert what a
// caller of the service — rather than of the endpoint — is handed.
import { savePreferences, saveSetupStep } from '../../services/preferences.service';
import {
    AffectedMealsResponse,
    MealFlag,
    PreferencesResponse,
    PreferencesSaveResponse,
} from '../../types/mealPlanning';
import { isMealPlanningEnabled } from '../../utils/featureFlags';
import {
    FIXTURE_ENDED_PLAN_START_DAY_KEY,
    addDaysToDayKey,
    makeCatalogFood,
    makePlan,
    makePreferences,
    makeRecipeVersion,
    makeUser,
    utcTodayDayKey,
} from '../setup/factories';
import { asUser, request } from '../setup/testApp';
import { truncateFeatureTables } from '../setup/testDb';

/**
 * The flag is read ONCE at import by `utils/featureFlags.ts`, behind an
 * accessor, exactly as Rule backend-architecture §9 requires — so assigning
 * `process.env.MEAL_PLANNING_ENABLED` mid-suite cannot change what the already
 * imported controller sees. The module is therefore mocked at module level (the
 * form Rule 4's mocking conventions prefer), spreading the real exports so
 * `postCommitAbort`, `mealPlanningFault` and `POST_COMMIT_ABORT_HEADER` keep
 * their real behaviour for every other module in the graph, and replacing only
 * the accessor under test. The implementation it starts with is the real one,
 * and `beforeEach` restores it, so a neighbouring suite cannot inherit an off
 * flag from this file.
 */
jest.mock('../../utils/featureFlags', () => {
    const actual = jest.requireActual<typeof import('../../utils/featureFlags')>(
        '../../utils/featureFlags',
    );

    return { ...actual, isMealPlanningEnabled: jest.fn(actual.isMealPlanningEnabled) };
});

const mealPlanningEnabled = jest.mocked(isMealPlanningEnabled);

/**
 * What the environment says the flag is, read from the REAL module rather than
 * assumed: `jestSetup.ts` sets `MEAL_PLANNING_ENABLED=true` for the whole run,
 * and restoring to this value keeps that fact in one place instead of hard
 * coding `true` in a dozen `afterEach`es.
 */
const FEATURE_ENABLED_BY_ENVIRONMENT = jest
    .requireActual<typeof import('../../utils/featureFlags')>('../../utils/featureFlags')
    .isMealPlanningEnabled();

/* ---------------------------------------------------------------------------
 * Identities, paths and the values every case is stated in
 * ------------------------------------------------------------------------- */

const USER_ID = 'preferences-suite-user';
const OTHER_USER_ID = 'preferences-suite-other-user';

/** Behind UTC, so the UTC day key is never earlier than "today" in this zone. */
const TIME_ZONE = 'America/New_York';

/** A second zone, for the "refreshed on every save" case. */
const OTHER_TIME_ZONE = 'Europe/Berlin';

/**
 * A third zone, for the cases that save a plan-bearing user a NEW zone.
 *
 * Different from the stored `TIME_ZONE`, so a half-written `time_zone` column
 * would be visible, and BEHIND UTC like it, which is the load-bearing half:
 * `OTHER_TIME_ZONE` is ahead of UTC, so for the last hours of a UTC day the day
 * key a save derives from it is already tomorrow — and the flag recomputation,
 * which excludes a plan whose `end_date` is before that day (§0.5.1), would
 * then skip the one-day fixture entirely and recompute nothing. A zone west of
 * UTC can only ever name today or yesterday, both of which keep the fixture's
 * week running.
 */
const WESTERN_TIME_ZONE = 'America/Los_Angeles';

const PREFERENCES_PATH = '/api/meal-planning/preferences';
const TARGETS_PATH = '/api/meal-planning/targets';

const stepPath = (step: string): string => `${PREFERENCES_PATH}/steps/${step}`;

/**
 * The response surface every case reads, declared structurally so this file
 * does not import supertest: what it asserts on is a status and a body.
 */
interface HttpResponse {
    status: number;
    body: unknown;
}

/** The `400 invalid_request` body shape §0.5.2 declares. */
interface InvalidRequestBody {
    error: string;
    details: { field: string; code: string }[];
}

/** The `409 stale_revision` body the preference routes carry. */
interface StaleRevisionBody {
    error: string;
    currentRevision: number;
}

type JsonBody = Record<string, unknown>;

/* ---------------------------------------------------------------------------
 * Requests
 * ------------------------------------------------------------------------- */

const readPreferences = async (uid: string = USER_ID): Promise<HttpResponse> =>
    asUser(request.get(PREFERENCES_PATH), { uid });

const saveStep = async (
    step: string,
    body: JsonBody,
    uid: string = USER_ID,
): Promise<HttpResponse> => asUser(request.put(stepPath(step)), { uid }).send(body);

const saveAll = async (body: JsonBody, uid: string = USER_ID): Promise<HttpResponse> =>
    asUser(request.put(PREFERENCES_PATH), { uid }).send(body);

/**
 * A save that must have succeeded, with the refusal in the failure message.
 *
 * A bare `expect(status).toBe(200)` here would report "expected 200, received
 * 400" and leave the reader to go and find which field was refused; the body is
 * the one piece of information that makes a broken fixture diagnosable.
 */
const expectSaved = (response: HttpResponse, what: string): PreferencesSaveResponse => {
    if (response.status !== 200) {
        throw new Error(
            `${what} was refused with ${response.status}: ${JSON.stringify(response.body)}`,
        );
    }

    return response.body as PreferencesSaveResponse;
};

const saveStepOk = async (
    step: string,
    body: JsonBody,
    uid: string = USER_ID,
): Promise<PreferencesSaveResponse> =>
    expectSaved(await saveStep(step, body, uid), `the ${step} step`);

const saveAllOk = async (body: JsonBody, uid: string = USER_ID): Promise<PreferencesSaveResponse> =>
    expectSaved(await saveAll(body, uid), 'the full save');

const readPreferencesOk = async (uid: string = USER_ID): Promise<PreferencesResponse> => {
    const response = await readPreferences(uid);

    if (response.status !== 200) {
        throw new Error(
            `reading preferences answered ${response.status}: ${JSON.stringify(response.body)}`,
        );
    }

    return response.body as PreferencesResponse;
};

/* ---------------------------------------------------------------------------
 * Stored state
 * ------------------------------------------------------------------------- */

const storedRow = async (uid: string = USER_ID) =>
    prisma.meal_plan_preferences.findUnique({ where: { user_id: uid } });

const storedRowOrThrow = async (uid: string = USER_ID) =>
    prisma.meal_plan_preferences.findUniqueOrThrow({ where: { user_id: uid } });

const storedRevision = async (uid: string = USER_ID): Promise<number> =>
    (await storedRowOrThrow(uid)).revision;

const planRevision = async (planId: string): Promise<number> =>
    (await prisma.meal_plans.findUniqueOrThrow({ where: { id: planId }, select: { revision: true } }))
        .revision;

/** One planned meal's stored `flags` column, as JSONB round-trips it. */
const storedFlags = async (mealId: string): Promise<unknown> =>
    (
        await prisma.meal_plan_meals.findUniqueOrThrow({
            where: { id: mealId },
            select: { flags: true },
        })
    ).flags;

/**
 * One planned meal's stored `revision`, which a flag recomputation must NOT
 * move: flags are derived from preferences rather than a change to what was
 * planned, and the revision clients pin for a write is the plan's.
 */
const storedMealRevision = async (mealId: string): Promise<number> =>
    (
        await prisma.meal_plan_meals.findUniqueOrThrow({
            where: { id: mealId },
            select: { revision: true },
        })
    ).revision;

/** The plan-level audit record the last recomputation left behind. */
const storedIncompatibilityFlags = async (planId: string): Promise<unknown> =>
    (
        await prisma.meal_plans.findUniqueOrThrow({
            where: { id: planId },
            select: { incompatibility_flags: true },
        })
    ).incompatibility_flags;

/* ---------------------------------------------------------------------------
 * Step payloads — one valid answer per payload-bearing step
 *
 * `targets_manual` is absent by design: it is a stored resume marker for the
 * manual-target route and never a `:step` segment (§0.5.2 routes that answer
 * through `PUT /meal-planning/targets`), which is asserted below rather than
 * assumed.
 * ------------------------------------------------------------------------- */

/**
 * The zone goes FIRST so a case's own override wins: every builder below takes
 * overrides, and a `timeZone` appended after them would silently swallow the
 * one a zone case is trying to send.
 */
const withZone = (payload: JsonBody): JsonBody => ({ timeZone: TIME_ZONE, ...payload });

/** The goal weight sits below the body step's weight, so the tuple is coherent. */
const GOAL_WEIGHT_KG = 70;
const CURRENT_WEIGHT_KG = 79;

const goalPayload = (overrides: JsonBody = {}): JsonBody =>
    withZone({ goal: 'lose', goalWeightKg: GOAL_WEIGHT_KG, paceLbPerWeek: 1, ...overrides });

const bodyPayload = (overrides: JsonBody = {}): JsonBody =>
    withZone({
        age: 34,
        heightCm: 178,
        weightKg: CURRENT_WEIGHT_KG,
        sexForEstimate: 'female',
        heightUnitPref: 'ft_in',
        weightUnitPref: 'lb',
        ...overrides,
    });

const activityPayload = (overrides: JsonBody = {}): JsonBody =>
    withZone({ activityLevel: 'lightly_active', ...overrides });

const dietPayload = (overrides: JsonBody = {}): JsonBody =>
    withZone({ diet: 'vegetarian', allergens: ['milk', 'tree_nuts'], ...overrides });

const dislikesPayload = (overrides: JsonBody = {}): JsonBody =>
    withZone({ dislikedFoodIds: [], ...overrides });

const THREE_MEAL_TIMES = [
    { slot: 'breakfast', time: '08:00' },
    { slot: 'lunch', time: '12:30' },
    { slot: 'dinner', time: '18:30' },
];

const schedulePayload = (overrides: JsonBody = {}): JsonBody =>
    withZone({ mealSchedule: 'three', mealTimes: THREE_MEAL_TIMES, ...overrides });

const cookingPayload = (overrides: JsonBody = {}): JsonBody =>
    withZone({ cookingTimeLimitMin: 30, budget: null, noBudgetPreference: true, ...overrides });

const reviewPayload = (overrides: JsonBody = {}): JsonBody =>
    withZone({ startDate: utcTodayDayKey(), ...overrides });

interface StepSave {
    step: string;
    payload: JsonBody;
}

/** The estimated route's seven counted steps, in wizard order. */
const ESTIMATED_ROUTE: readonly StepSave[] = [
    { step: 'goal', payload: goalPayload() },
    { step: 'body', payload: bodyPayload() },
    { step: 'activity', payload: activityPayload() },
    { step: 'diet', payload: dietPayload() },
    { step: 'dislikes', payload: dislikesPayload() },
    { step: 'schedule', payload: schedulePayload() },
    { step: 'cooking', payload: cookingPayload() },
];

/**
 * Walks the wizard, pinning each save with the revision the previous response
 * reported — which is exactly what the client does, and what makes the walk a
 * test of the protocol rather than a setup shortcut. The first `goal` save
 * pins nothing, because there is no row yet.
 */
const walkEstimatedRoute = async (
    steps: readonly StepSave[] = ESTIMATED_ROUTE,
    uid: string = USER_ID,
): Promise<PreferencesSaveResponse[]> => {
    const saved: PreferencesSaveResponse[] = [];
    let revision = NO_PREFERENCES_REVISION;

    for (const { step, payload } of steps) {
        const body =
            revision === NO_PREFERENCES_REVISION ? payload : { ...payload, expectedRevision: revision };
        const result = await saveStepOk(step, body, uid);

        revision = result.preferences.revision;
        saved.push(result);
    }

    return saved;
};

/* ---------------------------------------------------------------------------
 * The zone canonicalisation the server performs, derived here independently
 * rather than imported: the claim is that the endpoint stores the runtime's
 * canonical spelling of an alias, and computing it from `Intl` in the test is
 * what makes that a comparison instead of a restatement of the code under test.
 * ------------------------------------------------------------------------- */

const canonicalZone = (name: string): string =>
    new Intl.DateTimeFormat('en-US', { timeZone: name }).resolvedOptions().timeZone;

/**
 * Days a plan fixture must span to be a RUNNING week rather than a finished
 * one.
 *
 * `makePlan`'s default week starts the day before UTC today, so a one-day
 * fixture ends yesterday and §0.5.1 reads it as ended — which is a real rule
 * and not a quirk to work around, so the day count says what it is for. Three
 * days puts the end date a day beyond UTC today, which keeps the week running
 * in every zone this suite uses and across a midnight the run itself might
 * cross.
 */
const RUNNING_WEEK_DAY_COUNT = 3;

/**
 * Clears the flag mock's recorded state and re-arms it with the real
 * environment's answer.
 *
 * `mockReset` first, so nothing about one case's arrangement survives into the
 * next (Rule 4's mocking conventions), and the implementation restored is the
 * REAL one read at import rather than a hard-coded `true`, so a neighbouring
 * suite can never inherit an off flag from this file.
 */
const restoreFeatureFlag = (): void => {
    mealPlanningEnabled.mockReset();
    mealPlanningEnabled.mockImplementation(() => FEATURE_ENABLED_BY_ENVIRONMENT);
};

beforeEach(async () => {
    restoreFeatureFlag();
    await truncateFeatureTables();
    await makeUser({ id: USER_ID });
    await makeUser({ id: OTHER_USER_ID });
});

afterEach(() => {
    restoreFeatureFlag();
});

afterAll(async () => {
    await truncateFeatureTables();
});

/* ---------------------------------------------------------------------------
 * GET /api/meal-planning/preferences
 * ------------------------------------------------------------------------- */

/**
 * What a user with no stored row must read back, stated in full and typed
 * against the contract so a member added to `PreferencesResponse` stops this
 * literal compiling until its not-started value is decided.
 *
 * Both unit preferences are null, and that is the contract rather than an
 * omission: the server owns no unit defaults, so the client derives its
 * first-entry toggles from the weight unit the user has already chosen
 * elsewhere in the app (§0.5.2). A server-side default here would overrule it.
 */
const NOT_STARTED: PreferencesResponse = {
    setupStatus: 'not_started',
    setupStep: null,
    reviewStartDate: null,
    timeZone: null,
    targetRoute: null,
    revision: 0,
    goal: null,
    goalWeightKg: null,
    paceLbPerWeek: null,
    age: null,
    heightCm: null,
    weightKg: null,
    sexForEstimate: null,
    heightUnitPref: null,
    weightUnitPref: null,
    activityLevel: null,
    diet: null,
    allergens: [],
    dislikedFoods: [],
    dislikedFoodGroups: [],
    mealSchedule: null,
    mealTimes: [],
    cookingTimeLimitMin: null,
    budget: null,
    noBudgetPreference: false,
    budgetTier: null,
    hasActivePlan: false,
};

describe('GET /api/meal-planning/preferences', () => {
    it('answers the not-started shape for a user who has never saved anything', async () => {
        const response = await readPreferences();

        expect(response.status).toBe(200);
        expect(response.body).toEqual(NOT_STARTED);

        // Called out separately because it is the member most likely to acquire
        // a well-meant default, and a default here is a silent override of a
        // preference the user expressed on another screen.
        const preferences = response.body as PreferencesResponse;
        expect(preferences.heightUnitPref).toBeNull();
        expect(preferences.weightUnitPref).toBeNull();
    });

    it('creates no row, however often it is read', async () => {
        // The whole of "side-effect free". The client calls this before
        // onboarding to choose between starting setup and opening a plan, so a
        // row created by reading would report `in_progress` to a user who has
        // answered nothing and would turn their first step save into a
        // stale-revision conflict against a row they never knew existed.
        await readPreferences();
        await readPreferences();

        expect(await storedRow()).toBeNull();
        expect(await prisma.meal_plan_preferences.count()).toBe(0);
    });

    it('reads back every member of a stored row as the contract declares it', async () => {
        const disliked = await makeCatalogFood({
            display_name: 'Mushrooms, white',
            food_group: 'mushroom',
        });

        await makePreferences(USER_ID, {
            time_zone: TIME_ZONE,
            setup_status: 'ready_for_review',
            setup_step: 'review',
            review_start_date: new Date('2026-07-05T00:00:00.000Z'),
            target_route: 'estimated',
            goal: 'lose',
            goal_weight_kg: GOAL_WEIGHT_KG,
            pace_lb_per_week: 1,
            age: 34,
            height_cm: 178,
            weight_kg: CURRENT_WEIGHT_KG,
            sex_for_estimate: 'female',
            height_unit_pref: 'ft_in',
            weight_unit_pref: 'lb',
            activity_level: 'lightly_active',
            diet: 'vegetarian',
            allergens: ['milk', 'tree_nuts'],
            disliked_food_ids: [disliked.id],
            disliked_food_groups: ['mushroom'],
            meal_schedule: 'three_plus_snack',
            cooking_time_limit_min: 45,
            budget_amount: 120,
            budget_currency: 'USD',
            no_budget_preference: false,
            budget_tier: 2,
            revision: 7,
        });

        const response = await readPreferences();

        expect(response.status).toBe(200);
        expect(response.body).toEqual({
            setupStatus: 'ready_for_review',
            setupStep: 'review',
            reviewStartDate: '2026-07-05',
            timeZone: TIME_ZONE,
            targetRoute: 'estimated',
            revision: 7,
            goal: 'lose',
            goalWeightKg: GOAL_WEIGHT_KG,
            paceLbPerWeek: 1,
            age: 34,
            heightCm: 178,
            weightKg: CURRENT_WEIGHT_KG,
            sexForEstimate: 'female',
            heightUnitPref: 'ft_in',
            weightUnitPref: 'lb',
            activityLevel: 'lightly_active',
            diet: 'vegetarian',
            allergens: ['milk', 'tree_nuts'],
            dislikedFoods: [{ id: disliked.id, name: 'Mushrooms, white', foodGroup: 'mushroom' }],
            dislikedFoodGroups: ['mushroom'],
            mealSchedule: 'three_plus_snack',
            // Wire order, not time order: the snack goes last although its time
            // falls between lunch and dinner, which is the case §0.5.2 allows.
            mealTimes: [
                { slot: 'breakfast', time: '08:00' },
                { slot: 'lunch', time: '12:30' },
                { slot: 'dinner', time: '18:30' },
                { slot: 'snack', time: '15:30' },
            ],
            cookingTimeLimitMin: 45,
            budget: { amount: 120, currency: 'USD' },
            noBudgetPreference: false,
            budgetTier: 2,
            hasActivePlan: false,
        } satisfies PreferencesResponse);
    });

    it('answers with stable machine codes rather than display prose', async () => {
        await makePreferences(USER_ID, {
            goal: 'lose',
            pace_lb_per_week: 1,
            goal_weight_kg: GOAL_WEIGHT_KG,
            activity_level: 'lightly_active',
            diet: 'vegetarian',
            meal_schedule: 'three_plus_snack',
            setup_status: 'ready_for_review',
            setup_step: 'review',
        });

        const preferences = await readPreferencesOk();

        // The client maps every one of these through `strings.ts`, so a value
        // carrying a space or a capital is copy that has leaked out of the
        // server and cannot be translated or restyled.
        for (const code of [
            preferences.setupStatus,
            preferences.setupStep,
            preferences.targetRoute,
            preferences.goal,
            preferences.sexForEstimate,
            preferences.activityLevel,
            preferences.diet,
            preferences.mealSchedule,
            preferences.heightUnitPref,
            preferences.weightUnitPref,
            ...preferences.allergens,
        ]) {
            if (code !== null) {
                expect(code).toMatch(/^[a-z][a-z_]*$/);
            }
        }
    });

    it('returns empty arrays rather than nulls for the four collection members', async () => {
        // The mapper's nullability rule (Rule backend-architecture §6): a
        // non-negotiable field gets a real default, never an optional the
        // client's io-ts codec has to guess about.
        await makePreferences(USER_ID, {
            setup_status: 'in_progress',
            setup_step: 'goal',
            meal_schedule: null,
            allergens: [],
            disliked_food_ids: [],
            disliked_food_groups: [],
        });

        const preferences = await readPreferencesOk();

        expect(preferences.allergens).toEqual([]);
        expect(preferences.dislikedFoods).toEqual([]);
        expect(preferences.dislikedFoodGroups).toEqual([]);
        expect(preferences.mealTimes).toEqual([]);
    });

    it('hydrates disliked ids into {id, name, foodGroup} in the order the user chose them', async () => {
        const olives = await makeCatalogFood({ display_name: 'Olives, green', food_group: 'olive' });
        const mushrooms = await makeCatalogFood({
            display_name: 'Mushrooms, white',
            food_group: 'mushroom',
        });

        // Stored in the opposite order to their creation, so a response that
        // simply echoed the database's own ordering would fail.
        await makePreferences(USER_ID, { disliked_food_ids: [mushrooms.id, olives.id] });

        expect((await readPreferencesOk()).dislikedFoods).toEqual([
            { id: mushrooms.id, name: 'Mushrooms, white', foodGroup: 'mushroom' },
            { id: olives.id, name: 'Olives, green', foodGroup: 'olive' },
        ]);
    });

    it('keeps a disliked food the catalog has since retired', async () => {
        // The publication filter applies when a dislike is SAVED, never when it
        // is read back: a food that was published when the user declined it is
        // still an answer they gave, and dropping it would show them a
        // preference screen missing one of their own selections.
        const retired = await makeCatalogFood({
            display_name: 'Blue cheese',
            food_group: 'cheese',
            publication_status: 'retired',
        });

        await makePreferences(USER_ID, { disliked_food_ids: [retired.id] });

        expect((await readPreferencesOk()).dislikedFoods).toEqual([
            { id: retired.id, name: 'Blue cheese', foodGroup: 'cheese' },
        ]);
    });

    it('omits a disliked id whose catalog row was deleted outright, rather than failing the read', async () => {
        const kept = await makeCatalogFood({ display_name: 'Olives, green', food_group: 'olive' });
        const deleted = await makeCatalogFood({ display_name: 'Anchovies', food_group: 'fish' });

        await makePreferences(USER_ID, { disliked_food_ids: [deleted.id, kept.id] });
        await prisma.catalog_foods.delete({ where: { id: deleted.id } });

        const response = await readPreferences();

        // A chip with no name is worse than one fewer chip, and a catalog
        // release must never turn this endpoint into a 500.
        expect(response.status).toBe(200);
        expect((response.body as PreferencesResponse).dislikedFoods).toEqual([
            { id: kept.id, name: 'Olives, green', foodGroup: 'olive' },
        ]);
    });

    it('reports hasActivePlan false when the user has no plan', async () => {
        await makePreferences(USER_ID, { time_zone: TIME_ZONE });

        expect((await readPreferencesOk()).hasActivePlan).toBe(false);
    });

    it('reports hasActivePlan true for a plan that is active and still running', async () => {
        await makePreferences(USER_ID, { time_zone: TIME_ZONE });
        await makePlan(USER_ID, { dayCount: RUNNING_WEEK_DAY_COUNT });

        expect((await readPreferencesOk()).hasActivePlan).toBe(true);
    });

    it('reports hasActivePlan false for a superseded plan', async () => {
        await makePreferences(USER_ID, { time_zone: TIME_ZONE });
        await makePlan(USER_ID, { dayCount: RUNNING_WEEK_DAY_COUNT, status: 'superseded' });

        expect((await readPreferencesOk()).hasActivePlan).toBe(false);
    });

    it('reports hasActivePlan false for a week that has ended, though it is stored active', async () => {
        // §0.5.1 reads an `active` plan whose `end_date` has passed as ended for
        // every rule. Reporting it as active would send the client to a week
        // that is over instead of offering to plan a new one.
        await makePreferences(USER_ID, { time_zone: TIME_ZONE });
        const ended = await makePlan(USER_ID, {
            startDate: FIXTURE_ENDED_PLAN_START_DAY_KEY,
            dayCount: 1,
        });

        expect(ended.status).toBe('active');
        expect((await readPreferencesOk()).hasActivePlan).toBe(false);
    });

    it('answers 401 without an identity header, so the route sits behind the auth boundary', async () => {
        // Mount order is load-bearing (Rule backend-architecture §3.1):
        // `mealPlanningRoutes` is mounted after `app.use(authenticateFirebaseToken)`,
        // and a router on the wrong side of that line would answer 200 here.
        const response: HttpResponse = await request.get(PREFERENCES_PATH);

        expect(response.status).toBe(401);
        expect(await storedRow()).toBeNull();
    });
});

/* ---------------------------------------------------------------------------
 * PUT /api/meal-planning/preferences/steps/:step
 * ------------------------------------------------------------------------- */

/**
 * The field each step's own parser names when its answer is missing — the
 * cheapest observable proof that the parser belonging to the `:step` SEGMENT
 * ran, rather than whichever one the body happened to suit.
 */
const STEP_SIGNATURE_FIELDS: readonly [string, string][] = [
    ['goal', 'goal'],
    ['body', 'age'],
    ['activity', 'activityLevel'],
    ['diet', 'diet'],
    ['dislikes', 'dislikedFoodIds'],
    ['schedule', 'mealSchedule'],
    ['cooking', 'cookingTimeLimitMin'],
    ['review', 'startDate'],
];

/** The setup state each save of the estimated walk must leave behind. */
const ESTIMATED_WALK_STATES: readonly [string, string][] = [
    ['in_progress', 'body'],
    ['in_progress', 'activity'],
    ['in_progress', 'diet'],
    ['in_progress', 'dislikes'],
    ['in_progress', 'schedule'],
    ['in_progress', 'cooking'],
    ['ready_for_review', 'review'],
];

const detailsOf = (response: HttpResponse): { field: string; code: string }[] =>
    (response.body as InvalidRequestBody).details;

const fieldsOf = (response: HttpResponse): string[] =>
    detailsOf(response).map((detail) => detail.field);

describe('PUT /api/meal-planning/preferences/steps/:step', () => {
    describe('routing and persistence', () => {
        it('creates the row on the first goal save and reports it in progress at revision 1', async () => {
            const saved = await saveStepOk('goal', goalPayload());

            expect(saved.preferences.setupStatus).toBe('in_progress');
            expect(saved.preferences.revision).toBe(1);
            expect(saved.preferences.goal).toBe('lose');
            expect(saved.preferences.goalWeightKg).toBe(GOAL_WEIGHT_KG);
            expect(saved.preferences.paceLbPerWeek).toBe(1);

            const stored = await storedRowOrThrow();
            expect(stored.setup_status).toBe('in_progress');
            expect(stored.revision).toBe(1);
            expect(stored.goal).toBe('lose');
        });

        it('stores every payload-bearing step through its own path segment', async () => {
            // The whole route in one walk, each save pinning the revision the
            // previous response reported, then the review step on top of it —
            // eight segments, eight parsers, one row.
            await walkEstimatedRoute();
            const reviewed = await saveStepOk('review', {
                ...reviewPayload(),
                expectedRevision: await storedRevision(),
            });

            expect(reviewed.preferences).toMatchObject({
                goal: 'lose',
                age: 34,
                heightCm: 178,
                weightKg: CURRENT_WEIGHT_KG,
                sexForEstimate: 'female',
                activityLevel: 'lightly_active',
                diet: 'vegetarian',
                allergens: ['milk', 'tree_nuts'],
                mealSchedule: 'three',
                mealTimes: THREE_MEAL_TIMES,
                cookingTimeLimitMin: 30,
                noBudgetPreference: true,
                reviewStartDate: utcTodayDayKey(),
            });
        });

        it.each(STEP_SIGNATURE_FIELDS)(
            'reaches the %s parser, which names its own field when the answer is missing',
            async (step, field) => {
                await makePreferences(USER_ID, { time_zone: TIME_ZONE, revision: 1 });

                const response = await saveStep(step, withZone({}));

                expect(response.status).toBe(400);
                expect((response.body as InvalidRequestBody).error).toBe('invalid_request');
                expect(detailsOf(response)).toContainEqual({
                    field,
                    code: PREFERENCE_FIELD_CODES.REQUIRED,
                });
            },
        );

        it('runs the parser of the step in the path, not the one the body would suit', async () => {
            await makePreferences(USER_ID, {
                time_zone: TIME_ZONE,
                revision: 1,
                activity_level: null,
                diet: null,
            });

            // An activity answer posted to the diet step. A router or controller
            // that dispatched on the body would accept this; the diet parser
            // refuses it, and says so about diet's own fields.
            const response = await saveStep('diet', activityPayload({ expectedRevision: 1 }));

            expect(response.status).toBe(400);
            expect(detailsOf(response)).toContainEqual({
                field: 'activityLevel',
                code: PREFERENCE_FIELD_CODES.READ_ONLY_FIELD,
            });
            expect(detailsOf(response)).toContainEqual({
                field: 'diet',
                code: PREFERENCE_FIELD_CODES.REQUIRED,
            });

            const stored = await storedRowOrThrow();
            expect(stored.activity_level).toBeNull();
            expect(stored.diet).toBeNull();
            expect(stored.revision).toBe(1);
        });

        it.each(['goals', 'Goal', 'body-measurements', 'targets_manual'])(
            'refuses the step segment "%s", which names no payload-bearing step',
            async (step) => {
                // `targets_manual` is in the list on purpose: it is a stored
                // resume marker for the manual-target route, saved through
                // `PUT /meal-planning/targets`, and accepting it as a segment
                // would let a client mark a resume point it never reached.
                const response = await saveStep(step, goalPayload());

                expect(response.status).toBe(400);
                expect(response.body).toEqual({
                    error: 'invalid_request',
                    details: [{ field: 'step', code: PREFERENCE_FIELD_CODES.UNKNOWN_STEP }],
                });
                expect(await storedRow()).toBeNull();
            },
        );

        it('refuses any step but goal before the row exists, because goal is the save that creates it', async () => {
            // Reported on `step` rather than as a stale revision: no revision the
            // client could pin would make an out-of-order first write acceptable,
            // and accepting it would create setup state from the middle of the
            // wizard with every earlier answer permanently absent.
            const response = await saveStep('diet', dietPayload());

            expect(response.status).toBe(400);
            expect(detailsOf(response)).toContainEqual({
                field: 'step',
                code: PREFERENCE_FIELD_CODES.NOT_ALLOWED,
            });
            expect(await storedRow()).toBeNull();
        });

        it('persists Skip as the manual route, storing no measurements', async () => {
            await saveStepOk('goal', goalPayload());

            const skipped = await saveStepOk('body', withZone({ skipped: true, expectedRevision: 1 }));

            expect(skipped.preferences.targetRoute).toBe('manual');
            // The resume marker records the manual route's own stop, so a
            // force-quit on the manual target screen comes back to it.
            expect(skipped.preferences.setupStep).toBe('targets_manual');
            expect(skipped.preferences.setupStatus).toBe('in_progress');

            // Skip is the answer that routes the user to manual targets, not an
            // instruction to delete measurements: nothing was written, and
            // nothing that was there is cleared.
            expect(skipped.preferences.age).toBeNull();
            expect(skipped.preferences.heightCm).toBeNull();
            expect(skipped.preferences.weightKg).toBeNull();
            expect(skipped.preferences.sexForEstimate).toBeNull();

            const stored = await storedRowOrThrow();
            expect(stored.target_route).toBe('manual');
            expect(stored.setup_step).toBe('targets_manual');
            expect(stored.revision).toBe(2);
        });

        it('reports affectedMealCount 0 when the user has no plan', async () => {
            const saved = await saveStepOk('goal', goalPayload());

            expect(saved.affectedMealCount).toBe(0);
        });
    });

    describe('the expectedRevision protocol', () => {
        it('accepts the first goal save with no expectedRevision', async () => {
            // The one save that may omit it: there is no row, so there is no
            // revision a client could know.
            const saved = await saveStepOk('goal', goalPayload());

            expect(saved.preferences.revision).toBe(1);
        });

        it('answers 409 stale_revision when a later save omits it', async () => {
            await saveStepOk('goal', goalPayload());

            const response = await saveStep('activity', activityPayload());

            expect(response.status).toBe(409);
            expect(response.body).toEqual({ error: 'stale_revision', currentRevision: 1 });
            // Treating the omission as "no opinion" is exactly how two clients
            // editing at once would both appear to succeed.
            expect(await storedRevision()).toBe(1);
            expect((await storedRowOrThrow()).activity_level).toBeNull();
        });

        it('answers 409 stale_revision when a later save pins the wrong revision', async () => {
            await saveStepOk('goal', goalPayload());

            const response = await saveStep('activity', activityPayload({ expectedRevision: 4 }));

            expect(response.status).toBe(409);
            expect(response.body).toEqual({ error: 'stale_revision', currentRevision: 1 });
            expect(await storedRevision()).toBe(1);
            expect((await storedRowOrThrow()).activity_level).toBeNull();
        });

        it('accepts the exact revision and increments it by exactly one', async () => {
            await saveStepOk('goal', goalPayload());

            const saved = await saveStepOk('body', bodyPayload({ expectedRevision: 1 }));

            expect(saved.preferences.revision).toBe(2);
            expect(await storedRevision()).toBe(2);
        });

        it('carries the current revision the client needs in order to recover', async () => {
            await saveStepOk('goal', goalPayload());
            await saveStepOk('body', bodyPayload({ expectedRevision: 1 }));

            const response = await saveStep('activity', activityPayload({ expectedRevision: 1 }));
            const body = response.body as StaleRevisionBody;

            // Not just "a conflict": the value the client re-pins on its retry.
            expect(body.error).toBe('stale_revision');
            expect(body.currentRevision).toBe(2);
            expect(body.currentRevision).toBe(await storedRevision());
        });
    });

    describe('two clients pinning the same revision', () => {
        beforeEach(async () => {
            await saveStepOk('goal', goalPayload());
        });

        it('lets exactly one win when the saves arrive one after the other', async () => {
            const first = await saveStep('diet', dietPayload({ diet: 'vegan', expectedRevision: 1 }));
            const second = await saveStep(
                'diet',
                dietPayload({ diet: 'pescatarian', expectedRevision: 1 }),
            );

            expect(first.status).toBe(200);
            expect(second.status).toBe(409);
            expect((second.body as StaleRevisionBody).error).toBe('stale_revision');
            expect(await storedRevision()).toBe(2);
            expect((await storedRowOrThrow()).diet).toBe('vegan');
        });

        it('lets exactly one win when the saves are in flight together', async () => {
            const responses = await Promise.all([
                saveStep('diet', dietPayload({ diet: 'vegan', expectedRevision: 1 })),
                saveStep('diet', dietPayload({ diet: 'pescatarian', expectedRevision: 1 })),
            ]);

            // Never two successes, and never two failures: the per-user advisory
            // lock serialises them and the losing parse sees the moved revision.
            expect(responses.map((response) => response.status).sort()).toEqual([200, 409]);

            const refused = responses.find((response) => response.status === 409) as HttpResponse;
            expect((refused.body as StaleRevisionBody)).toEqual({
                error: 'stale_revision',
                currentRevision: 2,
            });

            const stored = await storedRowOrThrow();
            expect(stored.revision).toBe(2);
            expect(['vegan', 'pescatarian']).toContain(stored.diet);

            const winner = responses.find((response) => response.status === 200) as HttpResponse;
            expect((winner.body as PreferencesSaveResponse).preferences.diet).toBe(stored.diet);
        });
    });

    describe('a response the client never received', () => {
        it('answers 409 with the next revision, over a stored row that already equals the draft', async () => {
            await saveStepOk('goal', goalPayload());
            const draft = dietPayload({ diet: 'vegan', allergens: ['milk'], expectedRevision: 1 });

            await saveStepOk('diet', draft);

            // The identical retry of a save whose response was lost.
            const retry = await saveStep('diet', draft);

            expect(retry.status).toBe(409);
            expect(retry.body).toEqual({ error: 'stale_revision', currentRevision: 2 });

            // The half that makes the client's silent resolution CORRECT: it
            // refetches, finds the stored values equal to its own draft, and
            // treats the conflict as the success it actually was. A 409 over a
            // row that did not hold the draft would make that resolution a lie.
            const preferences = await readPreferencesOk();
            expect(preferences.diet).toBe('vegan');
            expect(preferences.allergens).toEqual(['milk']);
            expect(preferences.revision).toBe(2);
        });
    });

    describe('the setup state machine, as stored', () => {
        it('advances not_started to in_progress to ready_for_review along the route', async () => {
            expect((await readPreferencesOk()).setupStatus).toBe('not_started');

            const saved = await walkEstimatedRoute();

            expect(
                saved.map(({ preferences }) => [preferences.setupStatus, preferences.setupStep]),
            ).toEqual(ESTIMATED_WALK_STATES);

            // The marker and the status are columns, not derivations: a resume
            // reads them back from storage.
            const stored = await storedRowOrThrow();
            expect(stored.setup_status).toBe('ready_for_review');
            expect(stored.setup_step).toBe('review');
            expect(stored.revision).toBe(ESTIMATED_ROUTE.length);
        });

        it('leaves a completed setup completed when one step is re-saved from plan settings', async () => {
            // The transition most likely to be got wrong, and the one whose
            // consequence is a user with a working week being asked the seven
            // onboarding questions again.
            await makePreferences(USER_ID, {
                time_zone: TIME_ZONE,
                setup_status: 'completed',
                setup_step: null,
                revision: 1,
            });

            const saved = await saveStepOk('diet', dietPayload({ diet: 'vegan', expectedRevision: 1 }));

            expect(saved.preferences.setupStatus).toBe('completed');
            expect(saved.preferences.diet).toBe('vegan');
            expect((await storedRowOrThrow()).setup_status).toBe('completed');
        });
    });

    describe('the time zone every step carries', () => {
        it('refuses a zone this runtime does not know, and writes nothing', async () => {
            const response = await saveStep('goal', goalPayload({ timeZone: 'Mars/Phobos' }));

            expect(response.status).toBe(400);
            expect(detailsOf(response)).toContainEqual({
                field: 'timeZone',
                code: PREFERENCE_FIELD_CODES.INVALID_TIME_ZONE,
            });
            expect(await storedRow()).toBeNull();
        });

        it('stores the canonical name for an alias a device may report', async () => {
            const alias = 'Etc/UTC';
            const canonical = canonicalZone(alias);

            // Without this the case could pass vacuously on a runtime whose ICU
            // data leaves the alias alone.
            expect(canonical).not.toBe(alias);

            const saved = await saveStepOk('goal', goalPayload({ timeZone: alias }));

            expect(saved.preferences.timeZone).toBe(canonical);
            expect((await storedRowOrThrow()).time_zone).toBe(canonical);
        });

        it('refreshes the stored zone on every save, so a user who has moved is planned in their new zone', async () => {
            await saveStepOk('goal', goalPayload());
            expect((await storedRowOrThrow()).time_zone).toBe(TIME_ZONE);

            await saveStepOk('activity', activityPayload({ expectedRevision: 1, timeZone: OTHER_TIME_ZONE }));

            expect((await storedRowOrThrow()).time_zone).toBe(OTHER_TIME_ZONE);
        });
    });
});

/* ---------------------------------------------------------------------------
 * PUT /api/meal-planning/preferences — the full save
 * ------------------------------------------------------------------------- */

/**
 * The six server-owned members of `PreferencesResponse` and one name that
 * exists nowhere — every key the editable DTO closes over. "This key is not
 * yours to write" is the same answer whether the key is on the response or
 * invented, and refusing rather than ignoring is what stops a client believing
 * it fabricated onboarding progress or that a misspelled answer was saved.
 */
const UNWRITABLE_KEYS: readonly [string, unknown][] = [
    ['setupStatus', 'completed'],
    ['setupStep', 'review'],
    ['revision', 9],
    ['budgetTier', 1],
    ['hasActivePlan', true],
    ['targetRoute', 'manual'],
    ['nickname', 'anything'],
];

const FOUR_MEAL_TIMES = [...THREE_MEAL_TIMES, { slot: 'snack', time: '15:30' }];

describe('PUT /api/meal-planning/preferences', () => {
    describe('the row it edits must already exist', () => {
        it('refuses a save from a user with no row, whatever revision it pins', async () => {
            // This endpoint EDITS; creation belongs to the first `goal` step. A
            // partial has nothing to apply to, and `expectedRevision: 0` would
            // otherwise compare equal to the absent row's read-back value and
            // materialise the setup state that step owns.
            const response = await saveAll({
                diet: 'vegan',
                timeZone: TIME_ZONE,
                expectedRevision: NO_PREFERENCES_REVISION,
            });

            expect(response.status).toBe(409);
            expect(response.body).toEqual({
                error: 'stale_revision',
                currentRevision: NO_PREFERENCES_REVISION,
            });
            expect(await storedRow()).toBeNull();
        });
    });

    describe('the expectedRevision protocol', () => {
        beforeEach(async () => {
            await makePreferences(USER_ID, { time_zone: TIME_ZONE, revision: 1 });
        });

        it('requires expectedRevision, unlike the first step save', async () => {
            const response = await saveAll({ diet: 'vegan', timeZone: TIME_ZONE });

            expect(response.status).toBe(409);
            expect(response.body).toEqual({ error: 'stale_revision', currentRevision: 1 });
            expect(await storedRevision()).toBe(1);
        });

        it('refuses a wrong revision and reports the current one', async () => {
            const response = await saveAll({ diet: 'vegan', timeZone: TIME_ZONE, expectedRevision: 5 });

            expect(response.status).toBe(409);
            expect(response.body).toEqual({ error: 'stale_revision', currentRevision: 1 });
        });

        it('accepts the exact revision and increments it once', async () => {
            const saved = await saveAllOk({ diet: 'vegan', timeZone: TIME_ZONE, expectedRevision: 1 });

            expect(saved.preferences.revision).toBe(2);
            expect(saved.preferences.diet).toBe('vegan');
            expect(await storedRevision()).toBe(2);
        });
    });

    describe('the closed editable key set', () => {
        it('accepts every one of the twenty editable keys in a single body', async () => {
            const mushrooms = await makeCatalogFood({
                display_name: 'Mushrooms, white',
                food_group: 'mushroom',
            });
            await makePreferences(USER_ID, { time_zone: TIME_ZONE, revision: 1 });

            const saved = await saveAllOk({
                goal: 'lose',
                goalWeightKg: GOAL_WEIGHT_KG,
                paceLbPerWeek: 1.5,
                age: 41,
                heightCm: 165,
                weightKg: CURRENT_WEIGHT_KG,
                sexForEstimate: 'female',
                heightUnitPref: 'cm',
                weightUnitPref: 'kg',
                activityLevel: 'active',
                diet: 'pescatarian',
                allergens: ['sesame'],
                dislikedFoodIds: [mushrooms.id],
                dislikedFoodGroups: ['olive'],
                mealSchedule: 'three_plus_snack',
                mealTimes: FOUR_MEAL_TIMES,
                cookingTimeLimitMin: 60,
                budget: { amount: 42, currency: 'USD' },
                noBudgetPreference: false,
                timeZone: OTHER_TIME_ZONE,
                expectedRevision: 1,
            });

            expect(saved.preferences).toMatchObject({
                goal: 'lose',
                goalWeightKg: GOAL_WEIGHT_KG,
                paceLbPerWeek: 1.5,
                age: 41,
                heightCm: 165,
                weightKg: CURRENT_WEIGHT_KG,
                sexForEstimate: 'female',
                heightUnitPref: 'cm',
                weightUnitPref: 'kg',
                activityLevel: 'active',
                diet: 'pescatarian',
                allergens: ['sesame'],
                dislikedFoods: [
                    { id: mushrooms.id, name: 'Mushrooms, white', foodGroup: 'mushroom' },
                ],
                // The union of the groups DERIVED from the selected food and the
                // group the user excluded on its own, sorted (§0.7.3).
                dislikedFoodGroups: ['mushroom', 'olive'],
                mealSchedule: 'three_plus_snack',
                mealTimes: FOUR_MEAL_TIMES,
                cookingTimeLimitMin: 60,
                budget: { amount: 42, currency: 'USD' },
                noBudgetPreference: false,
                timeZone: OTHER_TIME_ZONE,
                revision: 2,
            });
        });

        it('leaves every key the body does not name exactly as it was stored', async () => {
            await makePreferences(USER_ID, { time_zone: TIME_ZONE, revision: 1 });
            const before = await readPreferencesOk();

            const saved = await saveAllOk({
                cookingTimeLimitMin: 60,
                timeZone: TIME_ZONE,
                expectedRevision: 1,
            });

            // A partial is a partial: an omitted key means "leave this as it
            // is", and only the two members this request could move differ.
            expect(saved.preferences).toEqual({
                ...before,
                cookingTimeLimitMin: 60,
                revision: 2,
            });
        });

        it.each(UNWRITABLE_KEYS)('refuses the server-owned or unknown key %s', async (key, value) => {
            await makePreferences(USER_ID, { time_zone: TIME_ZONE, revision: 1 });
            const before = await storedRowOrThrow();

            const response = await saveAll({
                [key]: value,
                timeZone: TIME_ZONE,
                expectedRevision: 1,
            });

            expect(response.status).toBe(400);
            // The offending key is NAMED, which is what makes the 400 actionable
            // (Rule backend-architecture §8).
            expect(response.body).toEqual({
                error: 'invalid_request',
                details: [{ field: key, code: PREFERENCE_FIELD_CODES.READ_ONLY_FIELD }],
            });
            expect(await storedRowOrThrow()).toEqual(before);
        });

        it('rejects budgetTier as input while still deriving it into the response', async () => {
            await makePreferences(USER_ID, { time_zone: TIME_ZONE, revision: 1, budget_tier: 3 });

            const refused = await saveAll({
                budgetTier: 1,
                timeZone: TIME_ZONE,
                expectedRevision: 1,
            });

            expect(refused.status).toBe(400);
            expect(fieldsOf(refused)).toEqual(['budgetTier']);

            // The other half of the asymmetry: the tier is a DERIVED value, so
            // the response carries one the request was not allowed to state.
            // $42 a week over four meals a day is $1.50 a meal, which is tier 1
            // — USD is the only currency this version accepts (§0.5.2), and the
            // tier thresholds are calibrated to it.
            const saved = await saveAllOk({
                mealSchedule: 'three_plus_snack',
                mealTimes: FOUR_MEAL_TIMES,
                budget: { amount: 42, currency: 'USD' },
                noBudgetPreference: false,
                timeZone: TIME_ZONE,
                expectedRevision: 1,
            });

            expect(saved.preferences.budgetTier).toBe(1);
            expect((await storedRowOrThrow()).budget_tier).toBe(1);
        });
    });

    describe('the dislike list this endpoint handed the client, sent back', () => {
        /* -------------------------------------------------------------------
         * THE REQUEST BODY IS THE WHOLE LIST, NOT A DELTA. The preferences
         * screen renders the `dislikedFoods` the read returned and re-sends the
         * ids it holds with every save of that answer, so whatever the read
         * hydrates the write must accept back unchanged.
         *
         * The read deliberately hydrates a dislike the catalog has since
         * RETIRED ("a food that was published when the user declined it is
         * still an answer they gave"), while the write validated every
         * requested id as currently published — so the moment a release retired
         * anything the user disliked, the only edit the screen could get
         * accepted was removing that chip, and every other answer on it was
         * held hostage. Re-sending a stored id is not a new selection, so it is
         * judged as what it is; selecting an unpublished food still is one, and
         * is still refused (§0.5.2, "≤ 100 distinct published ids").
         * ----------------------------------------------------------------- */

        /** A published food and a retired one the user disliked before it was retired. */
        const retiredDislikeFixture = async (): Promise<{ published: string; retired: string }> => {
            const published = await makeCatalogFood({
                display_name: 'Mushrooms, white',
                food_group: 'mushroom',
            });
            const retired = await makeCatalogFood({
                display_name: 'Blue cheese',
                food_group: 'cheese',
                publication_status: 'retired',
            });

            await makePreferences(USER_ID, {
                time_zone: TIME_ZONE,
                revision: 1,
                disliked_food_ids: [published.id, retired.id],
                disliked_food_groups: ['cheese', 'mushroom'],
            });

            return { published: published.id, retired: retired.id };
        };

        it('accepts the list exactly as the read returned it', async () => {
            const { published, retired } = await retiredDislikeFixture();
            const read = await readPreferencesOk();

            expect(read.dislikedFoods.map((food) => food.id)).toEqual([published, retired]);

            const saved = await saveAllOk({
                dislikedFoodIds: read.dislikedFoods.map((food) => food.id),
                timeZone: TIME_ZONE,
                expectedRevision: 1,
            });

            expect(saved.preferences.dislikedFoods.map((food) => food.id)).toEqual([
                published,
                retired,
            ]);
            expect((await storedRowOrThrow()).disliked_food_ids).toEqual([published, retired]);
        });

        it('keeps deriving the retired food\u2019s group, so its whole kind stays excluded', async () => {
            // The group half is the rule as much as the id (§0.7.3): dropping it
            // would leave the retired food excluded while every other cheese
            // re-entered the user\u2019s plans.
            const { published, retired } = await retiredDislikeFixture();

            const saved = await saveAllOk({
                dislikedFoodIds: [published, retired],
                timeZone: TIME_ZONE,
                expectedRevision: 1,
            });

            expect(saved.preferences.dislikedFoodGroups).toEqual(['cheese', 'mushroom']);
        });

        it('lets an unrelated answer be edited in the same body', async () => {
            // The failure the user actually hit: a cooking-time or diet edit
            // refused because the dislike list it re-sent contained a retired
            // food they had no reason to touch.
            const { published, retired } = await retiredDislikeFixture();

            const saved = await saveAllOk({
                dislikedFoodIds: [published, retired],
                cookingTimeLimitMin: 45,
                timeZone: TIME_ZONE,
                expectedRevision: 1,
            });

            expect(saved.preferences.cookingTimeLimitMin).toBe(45);
            expect(saved.preferences.dislikedFoods.map((food) => food.id)).toEqual([
                published,
                retired,
            ]);
        });

        it('lets the user remove the retired food, which is the edit they can make', async () => {
            const { published, retired } = await retiredDislikeFixture();

            const saved = await saveAllOk({
                dislikedFoodIds: [published],
                timeZone: TIME_ZONE,
                expectedRevision: 1,
            });

            expect(saved.preferences.dislikedFoods.map((food) => food.id)).toEqual([published]);
            expect(saved.preferences.dislikedFoodGroups).toEqual(['mushroom']);
            expect((await storedRowOrThrow()).disliked_food_ids).toEqual([published]);
            // The retired id is gone from the row, so it can never be re-added:
            // the next save would be selecting an unpublished food.
            const readded = await saveAll({
                dislikedFoodIds: [published, retired],
                timeZone: TIME_ZONE,
                expectedRevision: 2,
            });

            expect(readded.status).toBe(400);
            expect(detailsOf(readded)).toEqual([
                { field: 'dislikedFoodIds[1]', code: PREFERENCE_FIELD_CODES.UNKNOWN_VALUE },
            ]);
        });

        it('still refuses a NEWLY selected food the catalog has not published', async () => {
            // The published rule intact: storing an id nothing resolves would
            // store an exclusion that excludes nothing, and the user would have
            // declined an ingredient and still be served it.
            await makePreferences(USER_ID, { time_zone: TIME_ZONE, revision: 1 });
            const candidate = await makeCatalogFood({
                display_name: 'Anchovies',
                food_group: 'fish',
                publication_status: 'candidate',
            });

            const response = await saveAll({
                dislikedFoodIds: [candidate.id],
                timeZone: TIME_ZONE,
                expectedRevision: 1,
            });

            expect(response.status).toBe(400);
            expect(detailsOf(response)).toEqual([
                { field: 'dislikedFoodIds[0]', code: PREFERENCE_FIELD_CODES.UNKNOWN_VALUE },
            ]);
            expect((await storedRowOrThrow()).disliked_food_ids).toEqual([]);
        });

        it('refuses an id whose catalog row was deleted outright, which the read already drops', async () => {
            // Not the retired case: there is no row left to derive a group from,
            // so the exclusion could not work — and the read omits it, so a
            // client sending it is working from a stale list and should re-read.
            const deleted = await makeCatalogFood({ display_name: 'Anchovies', food_group: 'fish' });

            await makePreferences(USER_ID, {
                time_zone: TIME_ZONE,
                revision: 1,
                disliked_food_ids: [deleted.id],
            });
            await prisma.catalog_foods.delete({ where: { id: deleted.id } });

            expect((await readPreferencesOk()).dislikedFoods).toEqual([]);

            const response = await saveAll({
                dislikedFoodIds: [deleted.id],
                timeZone: TIME_ZONE,
                expectedRevision: 1,
            });

            expect(response.status).toBe(400);
            expect(fieldsOf(response)).toEqual(['dislikedFoodIds[0]']);
        });

        it('accepts the retired id through the dislikes STEP too, which sends the same list', async () => {
            // The wizard\u2019s own save of the same answer: one rule for both
            // endpoints, because `resolveDislikeWrites` is shared.
            const { published, retired } = await retiredDislikeFixture();

            const saved = await saveStepOk(
                'dislikes',
                dislikesPayload({ dislikedFoodIds: [published, retired], expectedRevision: 1 }),
            );

            expect(saved.preferences.dislikedFoods.map((food) => food.id)).toEqual([
                published,
                retired,
            ]);
        });
    });

    describe('the review step\u2019s start-date window', () => {
        /* -------------------------------------------------------------------
         * The window is `[today, max(today + 30, latest active plan's end + 1)]`
         * and `today` is the day key in the user's STORED zone (§0.5.2). Three
         * separate pieces of wiring produce that, and NO test at any level
         * exercised them together: `startDateWindow` is unit-tested in
         * `mealPlan.logic.test.ts`, but through the GENERATE path, which refuses
         * `out_of_range` — this step refuses `below_minimum` / `above_maximum`,
         * so those unit tests cannot detect a regression here. What was
         * unprotected was the wiring: which zone `today` is read in, whether the
         * plan-extended upper bound is consulted at all, and which codes come
         * back.
         *
         * Asserted at both edges, in both directions, so neither an off-by-one
         * nor a silently widened bound survives.
         * ----------------------------------------------------------------- */

        /** The window's width below the upper bound, per §0.5.2. */
        const MAX_START_OFFSET_DAYS = 30;

        const saveReview = async (startDate: string, expectedRevision = 1) =>
            saveStep('review', withZone({ startDate, expectedRevision }));

        const preparedRow = () =>
            makePreferences(USER_ID, {
                time_zone: TIME_ZONE,
                revision: 1,
                setup_status: 'ready_for_review',
                setup_step: 'review',
            });

        it('accepts today itself, the lower bound', async () => {
            await preparedRow();

            const response = await saveReview(utcTodayDayKey());

            expect(response.status).toBe(200);
            expect((await storedRowOrThrow()).review_start_date).not.toBeNull();
        });

        it('refuses yesterday with below_minimum, storing nothing', async () => {
            // A plan may not start in the past: the day is already partly spent,
            // and the diary for it may already hold entries.
            await preparedRow();

            const response = await saveReview(addDaysToDayKey(utcTodayDayKey(), -1));

            expect(response.status).toBe(400);
            expect(detailsOf(response)).toEqual([
                { field: 'startDate', code: PREFERENCE_FIELD_CODES.BELOW_MINIMUM },
            ]);

            const row = await storedRowOrThrow();
            expect(row.review_start_date).toBeNull();
            expect(row.revision).toBe(1);
        });

        it('accepts the 30th day ahead, the upper bound with no plan', async () => {
            await preparedRow();

            const response = await saveReview(
                addDaysToDayKey(utcTodayDayKey(), MAX_START_OFFSET_DAYS),
            );

            expect(response.status).toBe(200);
        });

        it('refuses the 31st day ahead with above_maximum, storing nothing', async () => {
            await preparedRow();

            const response = await saveReview(
                addDaysToDayKey(utcTodayDayKey(), MAX_START_OFFSET_DAYS + 1),
            );

            expect(response.status).toBe(400);
            expect(detailsOf(response)).toEqual([
                { field: 'startDate', code: PREFERENCE_FIELD_CODES.ABOVE_MAXIMUM },
            ]);

            const row = await storedRowOrThrow();
            expect(row.review_start_date).toBeNull();
            expect(row.revision).toBe(1);
        });

        it('refuses a non-calendar day before it ever reaches the window', async () => {
            await preparedRow();

            expect(detailsOf(await saveReview('2026-02-30'))).toEqual([
                { field: 'startDate', code: PREFERENCE_FIELD_CODES.INVALID_DATE },
            ]);
        });

        describe('when an active plan reaches beyond the 30-day bound', () => {
            /* ---------------------------------------------------------------
             * The upper bound must always admit the successor week of the plan
             * the user holds, or "Plan another week" could offer a start date
             * the server then refuses (§0.5.2). A plan ending 40 days out makes
             * `end + 1` the binding bound rather than `today + 30`.
             * ------------------------------------------------------------- */
            const PLAN_ENDS_DAYS_AHEAD = 40;

            /** A plan whose seven days end well past `today + 30`. */
            const farFuturePlan = async () => {
                // Seven days ending exactly PLAN_ENDS_DAYS_AHEAD from today, so
                // the bound this asserts is the plan's own end and not a week
                // boundary that happens to fall nearby.
                await makePlan(USER_ID, {
                    startDate: addDaysToDayKey(utcTodayDayKey(), PLAN_ENDS_DAYS_AHEAD - 6),
                });

                return addDaysToDayKey(utcTodayDayKey(), PLAN_ENDS_DAYS_AHEAD);
            };

            it('extends the bound to the day after the plan ends', async () => {
                await preparedRow();
                const endDate = await farFuturePlan();

                // Beyond today + 30, and accepted BECAUSE the plan reaches there.
                const response = await saveReview(addDaysToDayKey(endDate, 1));

                expect(response.status).toBe(200);
            });

            it('refuses the day after that, so the extension is exact', async () => {
                await preparedRow();
                const endDate = await farFuturePlan();

                const response = await saveReview(addDaysToDayKey(endDate, 2));

                expect(response.status).toBe(400);
                expect(detailsOf(response)).toEqual([
                    { field: 'startDate', code: PREFERENCE_FIELD_CODES.ABOVE_MAXIMUM },
                ]);
            });
        });

        describe('the zone today is read in', () => {
            /* ---------------------------------------------------------------
             * `today` is the day key in the user's STORED zone, never the
             * server's. A bare date plus a Firebase identity cannot otherwise
             * establish the user's calendar day (§0.5.2), and reading UTC
             * instead would refuse a user in Auckland the whole of their own
             * current day for the ~12 hours the two zones disagree.
             *
             * DRIVEN THROUGH THE SERVICE with a pinned `now` rather than the
             * wall clock: `saveSetupStep`'s fourth parameter exists for exactly
             * this, and the instant below is chosen so the two zones REALLY
             * differ. A wall-clock test would pass for reasons unrelated to the
             * zone whenever the two happen to agree — which they do for most of
             * the day, so such a test would be no protection at all.
             * ------------------------------------------------------------- */

            /** 20:00 UTC: already the 20th in Auckland, still the 19th in UTC. */
            const PINNED_NOW = new Date('2026-09-19T20:00:00.000Z');
            const AHEAD_ZONE = 'Pacific/Auckland';
            const AHEAD_ZONE_TODAY = '2026-09-20';
            const UTC_TODAY = '2026-09-19';

            const readyInZone = (timeZone: string) =>
                makePreferences(USER_ID, {
                    time_zone: timeZone,
                    revision: 1,
                    setup_status: 'ready_for_review',
                    setup_step: 'review',
                });

            it('accepts the stored zone\u2019s own today, which UTC has not reached', async () => {
                await readyInZone(AHEAD_ZONE);

                const result = await saveSetupStep(
                    USER_ID,
                    'review',
                    { startDate: AHEAD_ZONE_TODAY, timeZone: AHEAD_ZONE, expectedRevision: 1 },
                    PINNED_NOW,
                );

                expect(result.kind).toBe('ok');
                expect((await storedRowOrThrow()).review_start_date).toEqual(
                    new Date(`${AHEAD_ZONE_TODAY}T00:00:00.000Z`),
                );
            });

            it('refuses the UTC day, which is already yesterday in the stored zone', async () => {
                // The assertion that fails if `today` is ever read in server
                // time: under UTC this date IS today and would be accepted.
                await readyInZone(AHEAD_ZONE);

                const result = await saveSetupStep(
                    USER_ID,
                    'review',
                    { startDate: UTC_TODAY, timeZone: AHEAD_ZONE, expectedRevision: 1 },
                    PINNED_NOW,
                );

                expect(result).toMatchObject({
                    kind: 'error',
                    details: [
                        { field: 'startDate', code: PREFERENCE_FIELD_CODES.BELOW_MINIMUM },
                    ],
                });
                expect((await storedRowOrThrow()).review_start_date).toBeNull();
            });

            it('accepts that same UTC day for a user whose stored zone is UTC', async () => {
                // The control: one instant, one date, two stored zones, two
                // verdicts — so the refusal above is the ZONE's doing and not
                // the date's.
                await readyInZone('UTC');

                const result = await saveSetupStep(
                    USER_ID,
                    'review',
                    { startDate: UTC_TODAY, timeZone: 'UTC', expectedRevision: 1 },
                    PINNED_NOW,
                );

                expect(result.kind).toBe('ok');
            });
        });
    });

    describe('the food-group half of a dislike, which must name a real group', () => {
        /* -------------------------------------------------------------------
         * `dislikedFoodGroups` used to accept and STORE any string: no check
         * that the value is a term of the controlled taxonomy, and no bound on
         * how long one entry may be. Both halves matter, and differently.
         *
         * A value outside the taxonomy is an exclusion that excludes NOTHING —
         * no catalog food carries it, so the user declines a kind of food and
         * keeps being served it, which is the same harm the ids half already
         * refuses `unknown_value` for. An unbounded value is a storage and work
         * amplifier: the global 100 KB body limit is the only thing that capped
         * it, so one row could hold ~100 KB of text across the hundred entries
         * the count bound permits, every character of it normalised by the
         * spelling rule before it could be judged.
         *
         * ASSERTED IN BOTH DIRECTIONS, and the refusals are asserted to persist
         * NOTHING: the row and its revision must be byte-identical afterwards,
         * because a refusal that still bumped the revision would invalidate the
         * client's pinned revision and make the next legitimate save fail.
         * ----------------------------------------------------------------- */

        /** A term the shipped coverage plan really declares. */
        const REAL_GROUP = 'olive';
        /** Shaped like a term, declared by nothing. */
        const UNREAL_GROUP = 'bogus_group_not_in_taxonomy';

        const groupsPayload = (
            dislikedFoodGroups: unknown,
            expectedRevision = 1,
        ): Record<string, unknown> => withZone({ dislikedFoodGroups, expectedRevision });

        it('accepts a term the coverage plan declares', async () => {
            await makePreferences(USER_ID, { time_zone: TIME_ZONE, revision: 1 });

            const saved = await saveAllOk(groupsPayload([REAL_GROUP]));

            expect(saved.preferences.dislikedFoodGroups).toEqual([REAL_GROUP]);
            expect((await storedRowOrThrow()).disliked_food_groups).toEqual([REAL_GROUP]);
        });

        it('reads a display label as its catalog term, so the chip the user sees round-trips', async () => {
            await makePreferences(USER_ID, { time_zone: TIME_ZONE, revision: 1 });

            const saved = await saveAllOk(groupsPayload(['Blue cheese']));

            // Stored in the spelling it arrived in — the eligibility rule folds
            // both sides before comparing, so the exclusion works either way —
            // and accepted, which is the part that used to be impossible to
            // distinguish from accepting junk.
            expect(saved.preferences.dislikedFoodGroups).toEqual(['Blue cheese']);
        });

        it.each([
            ['a value outside the taxonomy', UNREAL_GROUP],
            ['a markup payload', '<script>alert(1)</script>'],
            ['a SQL payload', "' OR 1=1 --"],
            ['a near-miss of a real term', 'olives'],
        ])('refuses %s with unknown_value and stores nothing', async (_label, group) => {
            await makePreferences(USER_ID, { time_zone: TIME_ZONE, revision: 1 });

            const response = await saveAll(groupsPayload([group]));

            expect(response.status).toBe(400);
            expect(detailsOf(response)).toEqual([
                { field: 'dislikedFoodGroups[0]', code: PREFERENCE_FIELD_CODES.UNKNOWN_VALUE },
            ]);

            const row = await storedRowOrThrow();
            expect(row.disliked_food_groups).toEqual([]);
            expect(row.revision).toBe(1);
        });

        it('refuses the 90,000-character entry with above_maximum and stores nothing', async () => {
            // The audit's own reproduction. It reached the column intact before,
            // which is how one row came to hold ~90 KB of text.
            await makePreferences(USER_ID, { time_zone: TIME_ZONE, revision: 1 });

            const response = await saveAll(groupsPayload(['x'.repeat(90_000)]));

            expect(response.status).toBe(400);
            expect(detailsOf(response)).toEqual([
                { field: 'dislikedFoodGroups[0]', code: PREFERENCE_FIELD_CODES.ABOVE_MAXIMUM },
            ]);

            const row = await storedRowOrThrow();
            expect(row.disliked_food_groups).toEqual([]);
            expect(row.revision).toBe(1);
        });

        it('names the offending entry by ITS index, not the first', async () => {
            // The index is the client's own array position, which is what lets a
            // client highlight the chip the user must fix.
            await makePreferences(USER_ID, { time_zone: TIME_ZONE, revision: 1 });

            const response = await saveAll(groupsPayload([REAL_GROUP, 'mushroom', UNREAL_GROUP]));

            expect(response.status).toBe(400);
            expect(detailsOf(response)).toEqual([
                { field: 'dislikedFoodGroups[2]', code: PREFERENCE_FIELD_CODES.UNKNOWN_VALUE },
            ]);
        });

        it('sorts what it stores however the client ordered it', async () => {
            await makePreferences(USER_ID, { time_zone: TIME_ZONE, revision: 1 });

            const saved = await saveAllOk(groupsPayload([REAL_GROUP, 'avocado', 'cheese']));

            expect(saved.preferences.dislikedFoodGroups).toEqual(['avocado', 'cheese', REAL_GROUP]);
        });

        it('accepts a stored group the taxonomy no longer declares, so drift cannot brick the screen', async () => {
            // The same asymmetry the ids half documents, and it is not
            // hypothetical: a group enters storage by DERIVATION from a catalog
            // row, so a plan that renames a group leaves users holding the old
            // term. The read hands it back, the client re-sends it with every
            // save of the step, and judging it as a new selection would leave
            // removing that chip as the only accepted edit on the whole screen.
            await makePreferences(USER_ID, {
                time_zone: TIME_ZONE,
                revision: 1,
                disliked_food_groups: ['legacy_retired_group', REAL_GROUP],
            });

            const read = await readPreferencesOk();
            expect(read.dislikedFoodGroups).toEqual(['legacy_retired_group', REAL_GROUP]);

            const saved = await saveAllOk(groupsPayload(read.dislikedFoodGroups));

            expect(saved.preferences.dislikedFoodGroups).toEqual([
                'legacy_retired_group',
                REAL_GROUP,
            ]);
        });

        it('lets an unrelated answer be edited while a drifted group is re-sent', async () => {
            await makePreferences(USER_ID, {
                time_zone: TIME_ZONE,
                revision: 1,
                disliked_food_groups: ['legacy_retired_group'],
            });

            const saved = await saveAllOk(
                withZone({
                    dislikedFoodGroups: ['legacy_retired_group'],
                    cookingTimeLimitMin: 45,
                    expectedRevision: 1,
                }),
            );

            expect(saved.preferences.cookingTimeLimitMin).toBe(45);
            expect(saved.preferences.dislikedFoodGroups).toEqual(['legacy_retired_group']);
        });

        it('still refuses a NEW unreal group sent alongside a stored drifted one', async () => {
            // The escape is for the list the user already has, never a licence
            // to add more: otherwise one drifted group would reopen the field.
            await makePreferences(USER_ID, {
                time_zone: TIME_ZONE,
                revision: 1,
                disliked_food_groups: ['legacy_retired_group'],
            });

            const response = await saveAll(
                groupsPayload(['legacy_retired_group', UNREAL_GROUP]),
            );

            expect(response.status).toBe(400);
            expect(detailsOf(response)).toEqual([
                { field: 'dislikedFoodGroups[1]', code: PREFERENCE_FIELD_CODES.UNKNOWN_VALUE },
            ]);
            expect((await storedRowOrThrow()).disliked_food_groups).toEqual([
                'legacy_retired_group',
            ]);
        });

        it('keeps deriving a group from a catalog row the plan never declared', async () => {
            // Derivation is NOT judged against the vocabulary: the catalog is
            // the authority on what a food's group is, and refusing the save
            // would under-exclude the dislike the user actually asked for.
            const drifted = await makeCatalogFood({
                display_name: 'Kombu',
                food_group: 'sea_vegetable',
            });

            await makePreferences(USER_ID, { time_zone: TIME_ZONE, revision: 1 });

            const saved = await saveAllOk(
                withZone({ dislikedFoodIds: [drifted.id], expectedRevision: 1 }),
            );

            expect(saved.preferences.dislikedFoodGroups).toEqual(['sea_vegetable']);
        });
    });

    describe('the zone-only save that reconciles a moved device', () => {
        /* -------------------------------------------------------------------
         * `timeZone` is an ENVELOPE key and also a stored column, and this is
         * the one body where those two facts disagree. The contract has the
         * client re-send the device's zone on every full save so that a user
         * who has moved sees plan days in the zone of their most recent edit
         * (§0.5.2), and when nothing else changed that body carries the zone
         * and the pinned revision alone —
         * `mobile/src/screens/PlanSettings/index.util.ts::reconcilePreferencesTimeZone`
         * sends exactly `{timeZone, expectedRevision}`.
         *
         * Reading the zone as pure envelope refused that body as editing
         * nothing, so the stored calendar could never be refreshed by the only
         * channel the contract provides: every date the server derives — the
         * start-date window, the ended-plan boundary, `hasActivePlan` — stayed
         * in a zone the user had left. Whether the body edits anything is the
         * STORED zone's answer, so it is given where the row is in hand.
         * ----------------------------------------------------------------- */

        it('accepts it, stores the new zone and bumps the revision', async () => {
            await makePreferences(USER_ID, { time_zone: TIME_ZONE, revision: 1 });

            const saved = await saveAllOk({ timeZone: OTHER_TIME_ZONE, expectedRevision: 1 });

            expect(saved.preferences.timeZone).toBe(OTHER_TIME_ZONE);
            expect(saved.preferences.revision).toBe(2);
            expect((await storedRowOrThrow()).time_zone).toBe(OTHER_TIME_ZONE);
        });

        it('changes nothing else about the row it moves', async () => {
            await makePreferences(USER_ID, {
                time_zone: TIME_ZONE,
                revision: 1,
                goal: 'lose',
                pace_lb_per_week: 1,
                goal_weight_kg: GOAL_WEIGHT_KG,
                weight_kg: CURRENT_WEIGHT_KG,
                diet: 'vegetarian',
                allergens: ['milk'],
            });
            const before = await storedRowOrThrow();

            await saveAllOk({ timeZone: OTHER_TIME_ZONE, expectedRevision: 1 });

            // Byte-identical but for the two columns this save is allowed to
            // move: a zone-only body must not reach any other answer, and the
            // revision bump is what tells other clients the row moved.
            expect(await storedRowOrThrow()).toEqual({
                ...before,
                time_zone: OTHER_TIME_ZONE,
                revision: 2,
            });
        });

        it('stores the canonical spelling when the device reports an alias', async () => {
            await makePreferences(USER_ID, { time_zone: TIME_ZONE, revision: 1 });

            const saved = await saveAllOk({ timeZone: 'Etc/UTC', expectedRevision: 1 });

            expect(saved.preferences.timeZone).toBe(canonicalZone('Etc/UTC'));
            expect((await storedRowOrThrow()).time_zone).toBe(canonicalZone('Etc/UTC'));
        });

        it('refuses it as empty when the row already holds that zone', async () => {
            // The invariant the acceptance above must not cost: a save that
            // changes nothing would still bump the revision and invalidate
            // every other client's pinned value for no change at all. The
            // client avoids sending it (`reconcilePreferencesTimeZone` answers
            // `not_needed` when the zones already match), and the server says
            // so independently.
            await makePreferences(USER_ID, { time_zone: TIME_ZONE, revision: 1 });
            const before = await storedRowOrThrow();

            const response = await saveAll({ timeZone: TIME_ZONE, expectedRevision: 1 });

            expect(response.status).toBe(400);
            expect(detailsOf(response)).toEqual([
                { field: 'body', code: PREFERENCE_FIELD_CODES.REQUIRED },
            ]);
            expect(await storedRowOrThrow()).toEqual(before);
        });

        it('refuses an alias of the zone the row already holds', async () => {
            // Compared after canonicalisation: `Etc/UTC` and `UTC` are one
            // calendar, so an alias is not an edit and must not buy a revision.
            await makePreferences(USER_ID, { time_zone: canonicalZone('UTC'), revision: 1 });

            const response = await saveAll({ timeZone: 'Etc/UTC', expectedRevision: 1 });

            expect(response.status).toBe(400);
            expect(fieldsOf(response)).toEqual(['body']);
        });

        it('answers 409 rather than 400 when the zone moved but the revision has too', async () => {
            // The deferral must not turn a lost race into a malformed request:
            // the row decides both, and a real edit against a moved revision is
            // the 409 the client's re-read-and-compare recovery resolves.
            await makePreferences(USER_ID, { time_zone: TIME_ZONE, revision: 3 });

            const response = await saveAll({ timeZone: OTHER_TIME_ZONE, expectedRevision: 1 });

            expect(response.status).toBe(409);
            expect((await storedRowOrThrow()).time_zone).toBe(TIME_ZONE);
        });

        it('answers 409 for a user who has no row at all, which this endpoint never creates', async () => {
            const response = await saveAll({ timeZone: TIME_ZONE, expectedRevision: 0 });

            expect(response.status).toBe(409);
            expect(await storedRow()).toBeNull();
        });
    });

    describe('a refused save is one transaction that wrote nothing', () => {
        // BOTH REFUSALS HERE ARE DECIDED BEFORE ANYTHING IS WRITTEN — one on a
        // revision that has moved, one on a field the parser rejects — which is
        // exactly what they are for. The complementary half, a failure AFTER
        // the preference row has been written and inside the flag
        // recomputation, needs the flag fixture and is proved in "a save
        // refused after the preference row was written" below.
        it('writes nothing when the revision has moved', async () => {
            await makePreferences(USER_ID, { time_zone: TIME_ZONE, revision: 1 });
            const before = await storedRowOrThrow();

            const response = await saveAll({
                diet: 'vegan',
                cookingTimeLimitMin: 15,
                allergens: ['milk'],
                timeZone: OTHER_TIME_ZONE,
                expectedRevision: 7,
            });

            expect(response.status).toBe(409);
            // Byte-identical, including the time zone the refused request
            // carried: the whole save is one interactive transaction, so a
            // partial write here would be a real defect.
            expect(await storedRowOrThrow()).toEqual(before);
        });

        it('writes nothing when one field of an otherwise valid body is refused', async () => {
            await makePreferences(USER_ID, { time_zone: TIME_ZONE, revision: 1 });
            const before = await storedRowOrThrow();

            const response = await saveAll({
                diet: 'vegan',
                cookingTimeLimitMin: 37,
                timeZone: TIME_ZONE,
                expectedRevision: 1,
            });

            expect(response.status).toBe(400);
            expect(fieldsOf(response)).toEqual(['cookingTimeLimitMin']);
            expect(await storedRowOrThrow()).toEqual(before);
        });
    });
});

/* ---------------------------------------------------------------------------
 * One 400 per press, whichever stage decides its details
 *
 * Both saves parse the REQUEST first (§0.5.2, "validation applied before any
 * Prisma or planning work"), and a body every rule of which the request alone
 * decides is answered there, with no query at all — that part is
 * `api/requestParserWiring.test.ts`'s claim, against a recording Prisma stub.
 *
 * WHAT IS ASSERTED HERE IS THE ANSWER: the status, the code and the whole
 * detail list as they reach the wire. AAP §0.7.4 makes that list the contract —
 * validate-on-press "shows the inline errors for every offending control at
 * once" — so a body carrying an error the request alone decides BESIDE an
 * answer whose coherence rule reads the stored row must come back naming both.
 * The request stage cannot see the second, so for exactly those bodies it
 * defers, the row is read, and the authoritative parse answers. The cases below
 * cover both shapes: the ones the row has nothing to add to, whose answer is
 * unchanged and free, and the ones where it does, whose 400 now marks every
 * control on the first attempt instead of the second.
 * ------------------------------------------------------------------------- */

describe('one 400 per press, whichever stage decides its details', () => {
    it('answers the step save with every request-only field when the row has nothing to add', async () => {
        // `goalPayload` carries `goalWeightKg`, so a row rule IS applicable and
        // the request stage defers — but this user has no row, so no stored
        // weight can contradict the target and the authoritative parse produces
        // exactly the request's own list: a read-only key and a pace outside the
        // closed set, in the order this endpoint reports them.
        const response = await saveStep(
            'goal',
            goalPayload({ paceLbPerWeek: 9, setupStatus: 'completed' }),
        );

        expect(response.status).toBe(400);
        expect(response.body).toEqual({
            error: 'invalid_request',
            details: [
                { field: 'setupStatus', code: PREFERENCE_FIELD_CODES.READ_ONLY_FIELD },
                { field: 'paceLbPerWeek', code: PREFERENCE_FIELD_CODES.UNKNOWN_VALUE },
            ],
        });
        expect(await storedRow()).toBeNull();
    });

    it('answers the full save with every request-only field when the stored halves agree', async () => {
        // A lone `goalWeightKg` leaves the other two members of the coherence
        // tuple to the row, so this body is one of the four the full save
        // defers. The stored tuple is coherent with what it sends, so the row
        // adds nothing and the detail list is exactly the one this request has
        // always received.
        await makePreferences(USER_ID, {
            time_zone: TIME_ZONE,
            revision: 1,
            goal: 'lose',
            pace_lb_per_week: 1,
            goal_weight_kg: GOAL_WEIGHT_KG,
            weight_kg: CURRENT_WEIGHT_KG,
        });
        const before = await storedRowOrThrow();

        const response = await saveAll({
            goalWeightKg: GOAL_WEIGHT_KG,
            diet: 'carnivore',
            timeZone: TIME_ZONE,
            expectedRevision: 1,
        });

        expect(response.status).toBe(400);
        expect(response.body).toEqual({
            error: 'invalid_request',
            details: [{ field: 'diet', code: PREFERENCE_FIELD_CODES.UNKNOWN_VALUE }],
        });
        expect(await storedRowOrThrow()).toEqual(before);
    });

    it('names a request-only error and a coherence error in ONE 400, not across two attempts', async () => {
        // The case AAP 0.7.4 governs. This body sends a current weight that
        // contradicts the stored target — a rule only the row can apply —
        // BESIDE an invalid diet. Answering with the diet alone sent the user
        // back to a screen that marked one control, accepted their unchanged
        // weight because nothing said otherwise, and was refused again. Both
        // controls are named now, on the first press.
        await makePreferences(USER_ID, {
            time_zone: TIME_ZONE,
            revision: 1,
            goal: 'lose',
            pace_lb_per_week: 1,
            goal_weight_kg: GOAL_WEIGHT_KG,
            weight_kg: CURRENT_WEIGHT_KG,
        });
        const before = await storedRowOrThrow();

        const refused = await saveAll({
            weightKg: GOAL_WEIGHT_KG - 10,
            diet: 'carnivore',
            timeZone: TIME_ZONE,
            expectedRevision: 1,
        });

        expect(refused.status).toBe(400);
        expect(detailsOf(refused)).toEqual([
            { field: 'goalWeightKg', code: PREFERENCE_FIELD_CODES.NOT_BELOW_CURRENT_WEIGHT },
            { field: 'diet', code: PREFERENCE_FIELD_CODES.UNKNOWN_VALUE },
        ]);

        // Fixing both in one edit is accepted, which is what makes the merged
        // list actionable: the user is never told to change something that was
        // already right.
        const retried = await saveAll({
            weightKg: GOAL_WEIGHT_KG + 10,
            diet: 'vegan',
            timeZone: TIME_ZONE,
            expectedRevision: 1,
        });

        expect(retried.status).toBe(200);
        // The refused attempt wrote nothing, which is what makes the second one
        // a retry of the same edit rather than a follow-up to a partial save.
        expect(before.revision).toBe(1);
        expect((await storedRowOrThrow()).revision).toBe(2);
    });

    it('names a pace the stored goal forbids beside the request-only error, in ONE 400', async () => {
        // The other orientation of the same pair, and the one a partial edit
        // actually sends: a pace with no goal beside it. The stored goal decides
        // it — `maintain` has no pace to set — so the request stage cannot see
        // that control at all, and answering the diet alone would mark one of
        // the two the user must fix. Both arrive together.
        await makePreferences(USER_ID, {
            time_zone: TIME_ZONE,
            revision: 1,
            goal: 'maintain',
        });
        const before = await storedRowOrThrow();

        const response = await saveAll({
            paceLbPerWeek: 1,
            diet: 'carnivore',
            timeZone: TIME_ZONE,
            expectedRevision: 1,
        });

        expect(response.status).toBe(400);
        expect(response.body).toEqual({
            error: 'invalid_request',
            details: [
                { field: 'paceLbPerWeek', code: PREFERENCE_FIELD_CODES.NOT_ALLOWED },
                { field: 'diet', code: PREFERENCE_FIELD_CODES.UNKNOWN_VALUE },
            ],
        });
        expect(await storedRowOrThrow()).toEqual(before);
    });

    it('answers an envelope-only body whose zone is unknown with the same 400 the row would give', async () => {
        // The free half of the rule, seen from the wire. Only a usable zone can
        // make an envelope-only body an edit, so an unknown one edits nothing
        // whatever this row holds and the request stage answers alone — and the
        // client must not be able to tell, so the body it reads is exactly the
        // one the row-backed parse produces: the empty-save detail and the
        // zone's own, in this endpoint's order. (`requestParserWiring` proves
        // the same request touches no query.)
        await makePreferences(USER_ID, { time_zone: TIME_ZONE, revision: 1 });
        const before = await storedRowOrThrow();

        const response = await saveAll({ timeZone: 'Mars/Phobos', expectedRevision: 1 });

        expect(response.status).toBe(400);
        expect(response.body).toEqual({
            error: 'invalid_request',
            details: [
                { field: 'body', code: PREFERENCE_FIELD_CODES.REQUIRED },
                { field: 'timeZone', code: PREFERENCE_FIELD_CODES.INVALID_TIME_ZONE },
            ],
        });
        expect(await storedRowOrThrow()).toEqual(before);
    });
});

/* ---------------------------------------------------------------------------
 * Keys the client may not write
 *
 * A body whose ONLY problem is server-owned or unknown keys leaves the
 * preference service as `ReadOnlyFieldError` — the class the error inventory
 * pairs with the controller's `read_only_field` mapping, and which nothing
 * constructed before. It carries the WHOLE detail list, so every route to the
 * same 400 produces the same body: the controller's own boundary parse refuses
 * this body before the service is entered (it runs the same parser), the
 * service raises the class for any other caller, and the three cases below
 * assert the body the client reads back either way — three offending keys,
 * three details, one 400, on both endpoints.
 *
 * A MIXED body keeps travelling as the verdict, because one 400 must still name
 * every offending control (§0.7.4) — and that is asserted here in both
 * directions, so the split cannot degenerate into "throw for anything
 * containing a read-only key".
 * ------------------------------------------------------------------------- */

/** Two server-owned keys and one name that exists nowhere, in one body. */
const THREE_UNWRITABLE_KEYS: JsonBody = {
    setupStatus: 'completed',
    revision: 9,
    nickname: 'anything',
};

/** The three `read_only_field` details that body must earn, in the order it sent them. */
const THREE_READ_ONLY_DETAILS = [
    { field: 'setupStatus', code: PREFERENCE_FIELD_CODES.READ_ONLY_FIELD },
    { field: 'revision', code: PREFERENCE_FIELD_CODES.READ_ONLY_FIELD },
    { field: 'nickname', code: PREFERENCE_FIELD_CODES.READ_ONLY_FIELD },
];

/**
 * The same two saves called directly, for the one assertion the wire cannot
 * carry: which layer refused. Both bodies are the HTTP ones above.
 */
const READ_ONLY_RAISING_SAVES: readonly [string, () => Promise<unknown>][] = [
    ['the step save', () => saveSetupStep(USER_ID, 'goal', goalPayload(THREE_UNWRITABLE_KEYS))],
    [
        'the full save',
        () =>
            savePreferences(USER_ID, {
                ...THREE_UNWRITABLE_KEYS,
                timeZone: TIME_ZONE,
                expectedRevision: 1,
            }),
    ],
];

describe('a body whose only problem is keys the client may not write', () => {
    it('answers the step save with one detail per offending key', async () => {
        const response = await saveStep('goal', goalPayload(THREE_UNWRITABLE_KEYS));

        expect(response.status).toBe(400);
        expect(response.body).toEqual({
            error: 'invalid_request',
            details: THREE_READ_ONLY_DETAILS,
        });
        expect(await storedRow()).toBeNull();
    });

    it('answers the full save with one detail per offending key', async () => {
        await makePreferences(USER_ID, { time_zone: TIME_ZONE, revision: 1 });
        const before = await storedRowOrThrow();

        const response = await saveAll({
            ...THREE_UNWRITABLE_KEYS,
            timeZone: TIME_ZONE,
            expectedRevision: 1,
        });

        expect(response.status).toBe(400);
        expect(response.body).toEqual({
            error: 'invalid_request',
            details: THREE_READ_ONLY_DETAILS,
        });
        expect(await storedRowOrThrow()).toEqual(before);
    });

    it('keeps a read-only key and a field error in the same 400 on the full save', async () => {
        await makePreferences(USER_ID, { time_zone: TIME_ZONE, revision: 1 });

        const response = await saveAll({
            nickname: 'anything',
            diet: 'carnivore',
            timeZone: TIME_ZONE,
            expectedRevision: 1,
        });

        expect(response.status).toBe(400);
        expect(response.body).toEqual({
            error: 'invalid_request',
            details: [
                { field: 'nickname', code: PREFERENCE_FIELD_CODES.READ_ONLY_FIELD },
                { field: 'diet', code: PREFERENCE_FIELD_CODES.UNKNOWN_VALUE },
            ],
        });
    });

    // The step endpoint's mixed case is the first case of 'a body the request
    // alone refuses' above — `setupStatus` beside a pace outside the closed
    // set, in one 400 — so it is not repeated here.

    it.each(READ_ONLY_RAISING_SAVES)(
        'raises ReadOnlyFieldError from %s, carrying every offending key',
        async (_label, save) => {
            // THE ONE CASE IN THIS FILE THAT DOES NOT GO THROUGH `request`,
            // because the raise is not observable from outside: the controller
            // parses the request at its own boundary and refuses this body with
            // the identical `400 {error, details}` before the service is
            // entered, by design (the two run the same parser). The service is
            // still where the class is constructed — it is the answer every
            // caller of `saveSetupStep`/`savePreferences` gets — so the service
            // boundary is where the raise is asserted, with the same detail
            // list the HTTP cases above read back.
            await makePreferences(USER_ID, { time_zone: TIME_ZONE, revision: 1 });

            await expect(save()).rejects.toThrow(ReadOnlyFieldError);
            await expect(save()).rejects.toMatchObject({ details: THREE_READ_ONLY_DETAILS });
            expect(await storedRevision()).toBe(1);
        },
    );
});

/* ---------------------------------------------------------------------------
 * The incompatibility-flag lifecycle
 *
 * `preferences.service.ts` is the declared single owner of this lifecycle and
 * it is the ONE write to an active plan that carries no idempotency key
 * (§0.5.1) — so nothing below looks for a `meal_plan_actions` row and no
 * request below sends a key. What it does assert is the transaction's whole
 * effect: which meals carry which flags, whether the plan's revision moved, and
 * what the save reported as `affectedMealCount`.
 * ------------------------------------------------------------------------- */

/** What a milk-and-eggs, non-vegan, 40-minute lunch is flagged for. */
const ALL_FOUR_FLAGS: MealFlag[] = [
    // The user's OWN spelling of the allergens they selected, sorted — two
    // details under one code, which the JSONB array carries losslessly.
    { code: 'allergen', detail: ['eggs', 'milk'] },
    { code: 'diet', detail: ['vegan'] },
    { code: 'dislike', detail: ['Whole milk'] },
    { code: 'cooking_time', detail: ['40'] },
];

interface FlagFixture {
    planId: string;
    dayKey: string;
    /** A ten-minute, vegan, allergen-free breakfast: never flagged. */
    fastMealId: string;
    /** The forty-minute milk-and-eggs lunch every conflict below lands on. */
    slowMealId: string;
    /** Every day's compatible breakfast, in plan order. One entry for a one-day plan. */
    fastMealIds: string[];
    /** Every day's forty-minute lunch, in plan order — the meals a recompute must all move. */
    slowMealIds: string[];
    /** That lunch's recipe, so a second plan can carry the same conflict. */
    slowRecipeVersionId: string;
    /**
     * The breakfast's only ingredient — the one answer that can move a meal no
     * diet, allergen or cooking limit reaches, which is what the post-write
     * rollback cases need in order to fail AFTER a meal's flags were written.
     */
    fastFoodId: string;
    milkFoodId: string;
}

/**
 * A running one-day plan with one compatible meal and one that every kind of
 * preference conflict can reach.
 *
 * The week starts on the UTC day key and the stored zone is behind UTC, so the
 * plan is active and unended for the whole run — §0.5.1's endedness rule is a
 * real rule and this fixture stays on the right side of it rather than working
 * around it.
 *
 * Eligibility reads the INGREDIENT snapshots (the union of allergen tags, the
 * intersection of diet tags), the live `catalog_foods` row for the food group,
 * and the recipe's own `total_minutes` — never the recipe-level tag columns. So
 * the conflict is composed where the rule looks for it.
 */
const seedFlagFixture = async (
    uid: string,
    cookingTimeLimitMin: number,
    dayCount: number = 1,
): Promise<FlagFixture> => {
    const milk = await makeCatalogFood({
        display_name: 'Whole milk',
        food_group: 'dairy_milk',
        allergen_tags: ['milk', 'eggs'],
        diet_tags: [],
    });
    const oats = await makeCatalogFood({ display_name: 'Oats, rolled', food_group: 'grain_oat' });

    const slow = await makeRecipeVersion({
        catalogFoodId: milk.id,
        prep_minutes: 20,
        cook_minutes: 20,
    });
    const fast = await makeRecipeVersion({
        catalogFoodId: oats.id,
        prep_minutes: 5,
        cook_minutes: 5,
    });

    await makePreferences(uid, {
        time_zone: TIME_ZONE,
        revision: 1,
        cooking_time_limit_min: cookingTimeLimitMin,
    });

    const dayKey = utcTodayDayKey();
    const plan = await makePlan(uid, {
        startDate: dayKey,
        dayCount,
        slots: [
            { slot: 'breakfast', slot_time: '08:00', recipeVersionId: fast.id },
            { slot: 'lunch', slot_time: '12:30', recipeVersionId: slow.id },
        ],
    });

    // Every day plans the same two slots, so a multi-day fixture is the same
    // conflict repeated — which is what makes "one statement wrote them all"
    // assertable. Collected in plan order (day, then slot), the order the
    // recomputation's audit record is required to use.
    const fastMealIds: string[] = [];
    const slowMealIds: string[] = [];

    for (const day of plan.meal_plan_days) {
        const fastMeal = day.meal_plan_meals.find((meal) => meal.slot === 'breakfast');
        const slowMeal = day.meal_plan_meals.find((meal) => meal.slot === 'lunch');

        if (fastMeal === undefined || slowMeal === undefined) {
            throw new Error('the flag fixture did not plan both of its slots on every day');
        }

        fastMealIds.push(fastMeal.id);
        slowMealIds.push(slowMeal.id);
    }

    return {
        planId: plan.id,
        dayKey,
        fastMealId: fastMealIds[0],
        slowMealId: slowMealIds[0],
        fastMealIds,
        slowMealIds,
        slowRecipeVersionId: slow.id,
        fastFoodId: oats.id,
        milkFoodId: milk.id,
    };
};

/** The day envelope, for reading the flags back the way the client does. */
interface PlanDayEnvelope {
    day: { meals: { id: string; flags: MealFlag[] }[] };
}

const readPlanDayFlags = async (
    fixture: FlagFixture,
    mealId: string,
    uid: string = USER_ID,
): Promise<MealFlag[]> => {
    const response: HttpResponse = await asUser(
        request.get(`/api/meal-planning/plans/${fixture.planId}/days/${fixture.dayKey}`),
        { uid },
    );

    if (response.status !== 200) {
        throw new Error(
            `reading the plan day answered ${response.status}: ${JSON.stringify(response.body)}`,
        );
    }

    const meal = (response.body as PlanDayEnvelope).day.meals.find(
        (candidate) => candidate.id === mealId,
    );

    if (meal === undefined) {
        throw new Error(`the day envelope does not contain meal ${mealId}`);
    }

    return meal.flags;
};

describe('a preference save recomputes the active plan’s incompatibility flags', () => {
    it('flags exactly the meals the saved preferences no longer match, and bumps the plan revision', async () => {
        // Nothing is incompatible to begin with: the limit is 60 and the slowest
        // meal takes 40, so the flags below are caused by the save and not by
        // the fixture.
        const fixture = await seedFlagFixture(USER_ID, 60);
        expect(await planRevision(fixture.planId)).toBe(1);

        const saved = await saveAllOk({
            cookingTimeLimitMin: 30,
            timeZone: TIME_ZONE,
            expectedRevision: 1,
        });

        expect(saved.affectedMealCount).toBe(1);
        expect(await storedFlags(fixture.slowMealId)).toEqual([
            { code: 'cooking_time', detail: ['40'] },
        ]);
        // EXACTLY the affected meals: the ten-minute breakfast still fits.
        expect(await storedFlags(fixture.fastMealId)).toEqual([]);
        expect(await planRevision(fixture.planId)).toBe(2);

        expect(await storedIncompatibilityFlags(fixture.planId)).toEqual({
            flaggedMealIds: [fixture.slowMealId],
            codes: ['cooking_time'],
            recomputedAt: expect.any(String),
        });
    });

    it('records every reason for one meal as its own flag, several details and all', async () => {
        const fixture = await seedFlagFixture(USER_ID, 60);

        const saved = await saveAllOk({
            diet: 'vegan',
            allergens: ['milk', 'eggs'],
            dislikedFoodIds: [fixture.milkFoodId],
            cookingTimeLimitMin: 30,
            timeZone: TIME_ZONE,
            expectedRevision: 1,
        });

        expect(saved.affectedMealCount).toBe(1);

        // Order is the projection's contract rather than an accident of the
        // loop, so the settings screen cannot reshuffle a user's warnings
        // between two reads of an unchanged plan.
        expect(await storedFlags(fixture.slowMealId)).toEqual(ALL_FOUR_FLAGS);

        // The same array through the DTO the client actually decodes, so the
        // wire shape and the storage cannot disagree about it.
        expect(await readPlanDayFlags(fixture, fixture.slowMealId)).toEqual(ALL_FOUR_FLAGS);
        expect(await readPlanDayFlags(fixture, fixture.fastMealId)).toEqual([]);

        // The plan-level audit record orders its codes by
        // `PREFERENCE_FLAG_CODES` (diet first) while a MEAL's flags follow
        // `PlanningEligibilityCode` declaration order (allergen first). The two
        // orders are genuinely different contracts, so both are pinned as they
        // are rather than assumed to agree.
        expect(await storedIncompatibilityFlags(fixture.planId)).toEqual({
            flaggedMealIds: [fixture.slowMealId],
            codes: ['diet', 'allergen', 'dislike', 'cooking_time'],
            recomputedAt: expect.any(String),
        });
    });

    it('recomputes the same flags whichever endpoint saved the preference', async () => {
        // One flag lifecycle, two callers (§0.5.2: the step endpoint in edit
        // mode "recomputes incompatibility flags in the same transaction
        // exactly as the full save does"). This is the assertion that catches
        // the two paths drifting apart.
        const throughStep = await seedFlagFixture(USER_ID, 60);
        const throughFullSave = await seedFlagFixture(OTHER_USER_ID, 60);

        const stepSaved = await saveStepOk(
            'diet',
            dietPayload({ diet: 'vegan', allergens: ['milk', 'eggs'], expectedRevision: 1 }),
        );
        const fullSaved = await saveAllOk(
            {
                diet: 'vegan',
                allergens: ['milk', 'eggs'],
                timeZone: TIME_ZONE,
                expectedRevision: 1,
            },
            OTHER_USER_ID,
        );

        const expected: MealFlag[] = [
            { code: 'allergen', detail: ['eggs', 'milk'] },
            { code: 'diet', detail: ['vegan'] },
        ];

        expect(await storedFlags(throughStep.slowMealId)).toEqual(expected);
        expect(await storedFlags(throughFullSave.slowMealId)).toEqual(expected);
        expect(stepSaved.affectedMealCount).toBe(fullSaved.affectedMealCount);
        expect(stepSaved.affectedMealCount).toBe(1);
        expect(await planRevision(throughStep.planId)).toBe(2);
        expect(await planRevision(throughFullSave.planId)).toBe(2);
    });

    it('clears the flags when the preference is saved back, and bumps the revision again', async () => {
        const fixture = await seedFlagFixture(USER_ID, 60);

        await saveAllOk({ cookingTimeLimitMin: 30, timeZone: TIME_ZONE, expectedRevision: 1 });
        expect(await storedFlags(fixture.slowMealId)).not.toEqual([]);

        const restored = await saveAllOk({
            cookingTimeLimitMin: 60,
            timeZone: TIME_ZONE,
            expectedRevision: 2,
        });

        // Without this half, "flagged" could pass by being permanent.
        expect(restored.affectedMealCount).toBe(0);
        expect(await storedFlags(fixture.slowMealId)).toEqual([]);
        expect(await planRevision(fixture.planId)).toBe(3);
    });

    it('bumps no plan revision when a save leaves every verdict unchanged', async () => {
        // The recomputation is idempotent by construction: it writes only where
        // a verdict CHANGED. That is what stops a preference edit affecting
        // nothing from invalidating every other client's pinned plan revision.
        const fixture = await seedFlagFixture(USER_ID, 60);
        await saveAllOk({ cookingTimeLimitMin: 30, timeZone: TIME_ZONE, expectedRevision: 1 });
        expect(await planRevision(fixture.planId)).toBe(2);

        const again = await saveAllOk({ age: 41, timeZone: TIME_ZONE, expectedRevision: 2 });

        // The preference revision moves — an answer really did change — while
        // the plan's stands still, and the count still describes the plan.
        expect(again.preferences.revision).toBe(3);
        expect(again.affectedMealCount).toBe(1);
        expect(await planRevision(fixture.planId)).toBe(2);
        expect(await storedFlags(fixture.slowMealId)).toEqual([
            { code: 'cooking_time', detail: ['40'] },
        ]);
    });

    it('writes every changed meal of a multi-day plan, and leaves the unchanged ones alone', async () => {
        // The recomputation applies one plan's changed verdicts as a SINGLE
        // statement, so "it wrote the meals that moved" has to be asserted
        // across more than one of them: a per-meal loop and a batch that only
        // carries its first row are indistinguishable on a one-meal plan.
        // Three days × two slots — the three forty-minute lunches move, the
        // three ten-minute breakfasts do not.
        const fixture = await seedFlagFixture(USER_ID, 60, RUNNING_WEEK_DAY_COUNT);

        const saved = await saveAllOk({
            cookingTimeLimitMin: 30,
            timeZone: TIME_ZONE,
            expectedRevision: 1,
        });

        expect(saved.affectedMealCount).toBe(RUNNING_WEEK_DAY_COUNT);

        for (const mealId of fixture.slowMealIds) {
            expect(await storedFlags(mealId)).toEqual([{ code: 'cooking_time', detail: ['40'] }]);
            // The write carries the flags and nothing else.
            expect(await storedMealRevision(mealId)).toBe(1);
        }

        for (const mealId of fixture.fastMealIds) {
            expect(await storedFlags(mealId)).toEqual([]);
            expect(await storedMealRevision(mealId)).toBe(1);
        }

        // One audit record naming all three flagged meals in plan order, and
        // ONE revision bump however many meals moved.
        expect(await storedIncompatibilityFlags(fixture.planId)).toEqual({
            flaggedMealIds: fixture.slowMealIds,
            codes: ['cooking_time'],
            recomputedAt: expect.any(String),
        });
        expect(await planRevision(fixture.planId)).toBe(2);

        // And the no-op rerun over the same three meals: every verdict is
        // already stored, so the batch has nothing to apply and the plan's
        // revision stands still while the preference revision advances.
        const again = await saveAllOk({ age: 41, timeZone: TIME_ZONE, expectedRevision: 2 });

        expect(again.preferences.revision).toBe(3);
        expect(again.affectedMealCount).toBe(RUNNING_WEEK_DAY_COUNT);
        expect(await planRevision(fixture.planId)).toBe(2);
    });

    it('leaves a superseded plan untouched while flagging the active one', async () => {
        const active = await seedFlagFixture(USER_ID, 60);
        // The same running week and the same forty-minute recipe, stored
        // superseded: only the STATUS differs, so the case isolates the status
        // filter rather than the date one — and the meal WOULD be flagged if
        // the recomputation reached it, without which "untouched" would pass
        // vacuously.
        const superseded = await makePlan(USER_ID, {
            startDate: active.dayKey,
            dayCount: 1,
            status: 'superseded',
            slots: [
                {
                    slot: 'lunch',
                    slot_time: '12:30',
                    recipeVersionId: active.slowRecipeVersionId,
                },
            ],
        });
        const supersededMealId = superseded.meal_plan_days[0].meal_plan_meals[0].id;

        await saveAllOk({ cookingTimeLimitMin: 30, timeZone: TIME_ZONE, expectedRevision: 1 });

        expect(await storedFlags(active.slowMealId)).toEqual([
            { code: 'cooking_time', detail: ['40'] },
        ]);
        expect(await storedFlags(supersededMealId)).toEqual([]);
        expect(await planRevision(superseded.id)).toBe(1);
    });
});

/* ---------------------------------------------------------------------------
 * A save that fails AFTER the preference row was written
 *
 * Every negative case above this point is refused BEFORE the row is touched —
 * on a revision that has moved, on a field the parser rejects, or on the
 * feature gate — so between them they say nothing about the half of the save
 * that actually holds several writes. That half is: the preference row lands
 * first, then `meal_plan_meals.flags` is rewritten for every meal of every
 * active plan whose verdict moved, then `meal_plans.incompatibility_flags`
 * records what changed (§0.5.1, §0.7.3).
 *
 * WHAT A HALF-COMMITTED SAVE WOULD COST. A save that kept its preference write
 * and lost the recomputation would leave the user's revision bumped — so their
 * client believes the answer landed and pins the new value — with flags
 * recomputed for only part of their week and a plan-level audit record
 * describing a recomputation that never finished. The 16 settings banner counts
 * flagged meals, so it would under-report the meals the new answer really
 * affects, and "Review affected meals" would open on a subset while the rest of
 * the week silently disagreed with the preferences the same screen displays.
 * Nothing above can see that: only a failure INSIDE the recomputation can.
 *
 * SO ONE IS INJECTED, at the only place in that loop where a deterministic
 * failure is available without changing production code:
 * `preferences.logic.ts::evaluateMealAgainstPreferences`, the pure verdict
 * `recomputePlanFlags` asks for once per meal, spied with an implementation
 * that calls the real rule through for the first meal and throws on the second.
 * The fault therefore fires with the preference row already updated AND the
 * first meal's flags already written, which is what makes "nothing changed" a
 * statement about a ROLLBACK rather than about a request that never began.
 * Nothing about the lock, the transaction or the writes is stubbed, and the spy
 * is removed before anything is read back.
 *
 * BOTH SAVE ENDPOINTS ARE COVERED, because §0.5.2 gives them ONE flag
 * lifecycle: the step endpoint in edit mode "recomputes incompatibility flags
 * in the same transaction exactly as the full save does". Two paths into one
 * transaction is how one of them comes to commit half of it.
 * ------------------------------------------------------------------------- */

/**
 * The message the injected failure carries, asserted ABSENT from what the
 * handler logged (see `expectResidualFaultLogged`).
 *
 * What proves a case's 500 came from THIS fault rather than from a fixture the
 * request choked on is the seam's own reach — `evaluations` and
 * `verdictsBeforeFault` below — beside a `request_failed` event naming this
 * route, a 500, `internal_error` and an untyped throw. The message is the one
 * part of the fault that must never reach the log, so it is asserted there as
 * an absence rather than as the attribution.
 */
const FLAG_FAULT_MESSAGE = 'injected flag recomputation failure';

/**
 * Which meal the injected failure falls on, counted in the order
 * `recomputePlanFlags` reads them (day date, then slot order).
 *
 * The SECOND, and that is the whole point of the number: the first meal's
 * verdict is then computed for real and written before the transaction dies,
 * whereas failing on the first would land before any meal write and prove only
 * that the preference row alone rolls back.
 */
const FAILING_MEAL_POSITION = 2;

/**
 * Which active plan the second fault falls on, counted in the start-date order
 * `recomputeActivePlanFlags` walks them.
 *
 * The SECOND, because the audit write is the LAST statement of a plan's
 * recomputation and is followed only by reads: failing as the NEXT plan's
 * recomputation opens is what places a failure after
 * `meal_plans.incompatibility_flags` has been written without changing
 * production code. A failure AT that statement is not reachable from a test —
 * it is a direct Prisma call on the transaction client the service was handed,
 * and the only instrument that could intercept it is `prisma.$use` middleware
 * on the shared client, which has no unregister and would therefore follow this
 * file into every later case and suite.
 */
const FAILING_PLAN_POSITION = 2;

/** The message the second fault carries, asserted ABSENT from what the handler logged. */
const PLAN_LOOP_FAULT_MESSAGE = 'injected plan recipe read failure';

/**
 * Silences and records the handler's own error log for the duration of one
 * request: the 500 path records the fault as a server event and answers one
 * stable code (Rule backend-architecture §8), which every case below asserts —
 * and which would otherwise print a deliberate fault's event in a passing run.
 */
const captureHandlerLog = () => jest.spyOn(console, 'error').mockImplementation(() => undefined);

/**
 * Asserts the ONE server event the residual 500 emits, and that the injected
 * fault's message is not in it.
 *
 * `mealPlanning.controller.ts::failRequest` answers an unmapped throw with the
 * single stable code `internal_error` and records it through
 * `logSafeEvent('error', 'request_failed', …)`, which writes ONE string —
 * `[meal-planning] request_failed {…}` — to `console.error`. So a 500 is
 * attributed here by the route that answered it, the status, that code and the
 * throw's CLASS NAME rather than by the message it used to be named with.
 * `errorName` is `Error` for both faults below because both are deliberately
 * untyped: a mapped error class would have been answered as its own status, so
 * this field is what separates "the injected fault ended the request" from "a
 * typed rejection did".
 *
 * The message's ABSENCE is asserted beside them rather than assumed. Redacting
 * it is the point of that shape — a fault's message can carry a stack, a
 * failing statement's values or a connection string — so an assertion that
 * only matched the fields would still pass if the message came back.
 */
const expectResidualFaultLogged = (
    logged: readonly unknown[][],
    action: string,
    faultMessage: string,
): void => {
    expect(logged).toHaveLength(1);
    // ONE argument, and a string: the second argument that used to carry the
    // error object is exactly where the message reached the log.
    expect(logged[0]).toHaveLength(1);

    const [failureLine] = logged[0];

    expect(failureLine).toContain('[meal-planning] request_failed');
    expect(failureLine).toContain(`"action":"${action}"`);
    expect(failureLine).toContain(`"userId":"${USER_ID}"`);
    expect(failureLine).toContain('"status":500');
    expect(failureLine).toContain('"code":"internal_error"');
    expect(failureLine).toContain('"errorName":"Error"');
    expect(failureLine).not.toContain(faultMessage);
};

/** What a request driven through the injected recomputation failure leaves behind. */
interface PostWriteFaultOutcome {
    response: HttpResponse;
    /** How many meals the recomputation reached, the last of them the one that failed. */
    evaluations: number;
    /** The verdicts it obtained BEFORE the fault, in the order it read the meals. */
    verdictsBeforeFault: MealFlag[][];
    /** What the handler logged, so the 500 is attributed rather than assumed. */
    logged: unknown[][];
}

/**
 * Sends one request with the flag recomputation failing on
 * {@link FAILING_MEAL_POSITION}, and reports what the fault saw.
 *
 * The real rule is captured BEFORE the spy replaces the export, so the
 * call-through reaches the rule and not the mock; `jest` records a call before
 * it runs the implementation, which is what makes the counter below count the
 * invocation it is inside.
 */
const sendUnderFlagRecomputationFault = async (
    send: () => Promise<HttpResponse>,
): Promise<PostWriteFaultOutcome> => {
    const evaluateForReal = preferencesLogic.evaluateMealAgainstPreferences;
    const evaluate = jest
        .spyOn(preferencesLogic, 'evaluateMealAgainstPreferences')
        .mockImplementation((meal, preferences) => {
            if (evaluate.mock.calls.length >= FAILING_MEAL_POSITION) {
                throw new Error(FLAG_FAULT_MESSAGE);
            }

            return evaluateForReal(meal, preferences);
        });
    const logged = captureHandlerLog();

    try {
        const response = await send();

        return {
            response,
            evaluations: evaluate.mock.calls.length,
            // Only the calls that RETURNED: the failing one is recorded as a
            // throw, so this is exactly the set of verdicts the loop had in
            // hand — and therefore wrote where they differed — before the
            // transaction died.
            verdictsBeforeFault: evaluate.mock.results.flatMap((result) =>
                result.type === 'return' ? [result.value] : [],
            ),
            // Copied out rather than handed over by reference, because
            // `mockRestore` below resets the recorded state.
            logged: logged.mock.calls.map((call) => [...call]),
        };
    } finally {
        // `jest.config.ts` sets `clearMocks` and deliberately NOT
        // `restoreMocks`, so an implementation left installed here would follow
        // this file into every later case — including the ones that must reach
        // the real rule. Restored in a `finally`, so a failed expectation
        // cannot leak it either.
        evaluate.mockRestore();
        logged.mockRestore();
    }
};

/** What a request driven through the injected plan-loop failure leaves behind. */
interface PlanLoopFaultOutcome {
    response: HttpResponse;
    /** How many plans the recomputation opened, the last of them the one that failed. */
    plansOpened: number;
    logged: unknown[][];
}

/**
 * Sends one request with the recomputation failing as it opens plan
 * {@link FAILING_PLAN_POSITION}, so the plans before it are recomputed in full
 * — meal flags, plan revision and audit record — before the transaction dies.
 *
 * The seam is `recipe.service.ts::getPlanningRecipeVersionsByIds`, the single
 * owner of recipe reads and the first thing `recomputePlanFlags` asks for per
 * plan. Spread arguments rather than named ones, so the call-through cannot
 * drift from the signature it stands in for.
 */
const sendUnderSecondPlanRecipeReadFault = async (
    send: () => Promise<HttpResponse>,
): Promise<PlanLoopFaultOutcome> => {
    const readForReal = recipeService.getPlanningRecipeVersionsByIds;
    const read = jest
        .spyOn(recipeService, 'getPlanningRecipeVersionsByIds')
        .mockImplementation(async (...args) => {
            if (read.mock.calls.length >= FAILING_PLAN_POSITION) {
                throw new Error(PLAN_LOOP_FAULT_MESSAGE);
            }

            return readForReal(...args);
        });
    const logged = captureHandlerLog();

    try {
        const response = await send();

        return {
            response,
            plansOpened: read.mock.calls.length,
            logged: logged.mock.calls.map((call) => [...call]),
        };
    } finally {
        read.mockRestore();
        logged.mockRestore();
    }
};

/** Everything a preference save can move, as the database holds it and as the client reads it. */
interface PreferenceWorld {
    row: meal_plan_preferences;
    plan: meal_plans;
    meals: meal_plan_meals[];
    read: PreferencesResponse;
    affected: AffectedMealsResponse;
}

const readAffectedMeals = async (
    planId: string,
    uid: string = USER_ID,
): Promise<AffectedMealsResponse> => {
    const response: HttpResponse = await asUser(
        request.get(`/api/meal-planning/plans/${planId}/affected-meals`),
        { uid },
    );

    if (response.status !== 200) {
        throw new Error(
            `reading the affected meals answered ${response.status}: ${JSON.stringify(response.body)}`,
        );
    }

    return response.body as AffectedMealsResponse;
};

/**
 * The COMPLETE state a preference save can move, so that comparing it after a
 * refusal is byte-for-byte rather than a list of columns someone remembered.
 *
 * WHOLE ROWS, not projections. `revision`, `setup_step`, `setup_status`,
 * `time_zone`, `diet` and `allergens` are the members these cases are really
 * about, and every meal's `flags` and `revision` beside the plan's `revision`
 * and `incompatibility_flags` are what a half-finished recomputation would show
 * up in — but reading the remaining columns costs nothing and catches the
 * partial write nobody predicted. The meals are ordered exactly as
 * `recomputePlanFlags` walks them, so two snapshots of an unchanged plan are
 * element-wise comparable.
 *
 * The two READS are here for the same reason the rows are: what the client sees
 * has to roll back with what was stored, and `affected-meals` is the request
 * the 16 banner's "Review affected meals" action makes.
 */
const snapshotWorld = async (planId: string, uid: string = USER_ID): Promise<PreferenceWorld> => ({
    row: await storedRowOrThrow(uid),
    plan: await prisma.meal_plans.findUniqueOrThrow({ where: { id: planId } }),
    meals: await prisma.meal_plan_meals.findMany({
        where: { meal_plan_id: planId },
        orderBy: [{ meal_plan_days: { date: 'asc' } }, { sort_order: 'asc' }],
    }),
    read: await readPreferencesOk(uid),
    affected: await readAffectedMeals(planId, uid),
});

/**
 * The same snapshot over several plans, sequentially so two runs read them in
 * the same order.
 */
const snapshotWorlds = async (
    planIds: readonly string[],
    uid: string = USER_ID,
): Promise<PreferenceWorld[]> => {
    const worlds: PreferenceWorld[] = [];

    for (const planId of planIds) {
        worlds.push(await snapshotWorld(planId, uid));
    }

    return worlds;
};

describe('a save refused after the preference row was written', () => {
    /**
     * What the ten-minute vegan breakfast is flagged for once its own food is
     * disliked — the only verdict that moves a meal no diet, allergen or
     * cooking limit in the closed sets can reach.
     */
    const BREAKFAST_DISLIKE_FLAGS: MealFlag[] = [{ code: 'dislike', detail: ['Oats, rolled'] }];

    /**
     * What the forty-minute milk-and-eggs lunch is flagged for under the save
     * these cases re-send: the diet, the two allergens and the dislike, but NOT
     * `cooking_time` — that save raises the limit back to 60, so the flags it
     * lands are its own verdict rather than a leftover of the arrangement.
     */
    const LUNCH_PREFERENCE_FLAGS: MealFlag[] = [
        { code: 'allergen', detail: ['eggs', 'milk'] },
        { code: 'diet', detail: ['vegan'] },
        { code: 'dislike', detail: ['Whole milk'] },
    ];

    it('rolls a full save back whole, and accepts the identical request once the fault is gone', async () => {
        const fixture = await seedFlagFixture(USER_ID, 60);

        // A COMMITTED SAVE FIRST, so the state the refusal is compared against
        // is not the empty one: the lunch already carries a flag, the plan
        // already carries the audit record of it, and both revisions have
        // already moved. Against a fresh fixture "nothing changed" could pass
        // by nothing ever having been written; against this one it can only
        // mean the previous values were RESTORED.
        const arranged = await saveAllOk({
            cookingTimeLimitMin: 15,
            timeZone: TIME_ZONE,
            expectedRevision: 1,
        });

        expect(arranged.affectedMealCount).toBe(1);
        expect(await storedFlags(fixture.fastMealId)).toEqual([]);

        const before = await snapshotWorld(fixture.planId);

        expect(before.row.revision).toBe(2);
        expect(before.affected.meals.map((meal) => meal.mealId)).toEqual([fixture.slowMealId]);

        // Every column a partial write could leak, moved at once: the diet, the
        // allergens, the dislike pair, the cooking limit and the zone all
        // differ from what is stored, so a save that committed its preference
        // write and lost the rest is visible in the row rather than hidden
        // behind a value that happened to match already. Held in a const
        // because the recovery below re-sends it byte for byte.
        const save: JsonBody = {
            diet: 'vegan',
            allergens: ['milk', 'eggs'],
            dislikedFoodIds: [fixture.fastFoodId, fixture.milkFoodId],
            cookingTimeLimitMin: 60,
            timeZone: WESTERN_TIME_ZONE,
            expectedRevision: 2,
        };

        const faulted = await sendUnderFlagRecomputationFault(() => saveAll(save));

        // THE FAULT WAS REACHED, AND REACHED LATE. Two evaluations means the
        // loop ran past the preference write and past the breakfast, whose
        // verdict it obtained for real — and, differing from the empty flags
        // stored above, wrote — before the lunch failed.
        expect(faulted.evaluations).toBe(2);
        expect(faulted.verdictsBeforeFault).toEqual([BREAKFAST_DISLIKE_FLAGS]);

        // An unclassified failure is the one 500 these endpoints answer, and the
        // body is the single stable code a client can map — never this route's
        // prose and never anything internal (§0.5.2).
        expect(faulted.response.status).toBe(500);
        expect(faulted.response.body).toEqual({ error: 'internal_error' });
        expectResidualFaultLogged(faulted.logged, 'preferences.save', FLAG_FAULT_MESSAGE);

        // The whole world, byte for byte.
        expect(await snapshotWorld(fixture.planId)).toEqual(before);

        // THE OTHER DIRECTION, and the sharpest evidence the rollback was
        // complete: the IDENTICAL request, still pinning revision 2, is
        // ACCEPTED — which it could only be if the refused attempt left the
        // revision exactly where it found it — and now commits every part of
        // what the fault interrupted, once.
        const committed = await saveAllOk(save);

        expect(committed.preferences.revision).toBe(3);
        expect(committed.preferences.diet).toBe('vegan');
        expect(committed.preferences.timeZone).toBe(WESTERN_TIME_ZONE);
        expect(committed.affectedMealCount).toBe(2);
        expect(await storedFlags(fixture.fastMealId)).toEqual(BREAKFAST_DISLIKE_FLAGS);
        expect(await storedFlags(fixture.slowMealId)).toEqual(LUNCH_PREFERENCE_FLAGS);
        expect(await planRevision(fixture.planId)).toBe(before.plan.revision + 1);
        expect(await storedIncompatibilityFlags(fixture.planId)).toEqual({
            flaggedMealIds: [fixture.fastMealId, fixture.slowMealId],
            codes: ['diet', 'allergen', 'dislike'],
            recomputedAt: expect.any(String),
        });
    });

    it('rolls a step save back whole, leaving the setup state and the revision it pinned untouched', async () => {
        const fixture = await seedFlagFixture(USER_ID, 60);

        // Arranged THROUGH THE STEP ENDPOINT, so this case exercises that path
        // end to end instead of borrowing the full save's write: the cooking
        // step commits a fifteen-minute limit, which flags the forty-minute
        // lunch and leaves the ten-minute breakfast alone.
        const arranged = await saveStepOk(
            'cooking',
            cookingPayload({ cookingTimeLimitMin: 15, expectedRevision: 1 }),
        );

        expect(arranged.affectedMealCount).toBe(1);
        expect(await storedFlags(fixture.fastMealId)).toEqual([]);

        const before = await snapshotWorld(fixture.planId);

        expect(before.row.revision).toBe(2);
        expect(before.row.setup_status).toBe('completed');
        expect(before.affected.meals.map((meal) => meal.mealId)).toEqual([fixture.slowMealId]);

        // THE `dislikes` STEP, AND THE FIXTURE DECIDES THAT RATHER THAN TASTE.
        // A step carries exactly one answer (§0.5.2), and the breakfast — vegan
        // oats with no allergen tag and a ten-minute total — cannot be moved by
        // any `Diet` member, any allergen or any limit in the closed set. A
        // dislike of its own food is the only answer that moves it, and moving
        // the FIRST meal is what puts the injected failure after a real
        // meal-flag write. The zone moves with it, so the envelope every step
        // carries is part of what must roll back.
        const save: JsonBody = dislikesPayload({
            dislikedFoodIds: [fixture.fastFoodId, fixture.milkFoodId],
            timeZone: WESTERN_TIME_ZONE,
            expectedRevision: 2,
        });

        const faulted = await sendUnderFlagRecomputationFault(() => saveStep('dislikes', save));

        expect(faulted.evaluations).toBe(2);
        expect(faulted.verdictsBeforeFault).toEqual([BREAKFAST_DISLIKE_FLAGS]);
        expect(faulted.response.status).toBe(500);
        expect(faulted.response.body).toEqual({ error: 'internal_error' });
        // The STEP route's own event, which is what keeps this case a statement
        // about that endpoint: the two save paths answer the same code, so the
        // `action` is the only thing in the 500 that tells them apart.
        expectResidualFaultLogged(faulted.logged, 'preferences.saveStep', FLAG_FAULT_MESSAGE);

        // Including `setup_status` and `setup_step`: a step save writes the
        // state machine's output beside the answer, so a partial commit here
        // would move a completed user's stored progress as well as their
        // revision.
        expect(await snapshotWorld(fixture.planId)).toEqual(before);

        const committed = await saveStepOk('dislikes', save);

        expect(committed.preferences.revision).toBe(3);
        expect(committed.preferences.setupStatus).toBe('completed');
        expect(committed.preferences.timeZone).toBe(WESTERN_TIME_ZONE);
        expect(committed.preferences.dislikedFoods.map((food) => food.id)).toEqual([
            fixture.fastFoodId,
            fixture.milkFoodId,
        ]);
        expect(committed.affectedMealCount).toBe(2);
        expect(await storedFlags(fixture.fastMealId)).toEqual(BREAKFAST_DISLIKE_FLAGS);
        // The fifteen-minute limit the arrangement saved is still in force —
        // one step moves one answer — so the lunch carries the new dislike
        // beside the flag it already had.
        expect(await storedFlags(fixture.slowMealId)).toEqual([
            { code: 'dislike', detail: ['Whole milk'] },
            { code: 'cooking_time', detail: ['40'] },
        ]);
        expect(await planRevision(fixture.planId)).toBe(before.plan.revision + 1);
        expect(await storedIncompatibilityFlags(fixture.planId)).toEqual({
            flaggedMealIds: [fixture.fastMealId, fixture.slowMealId],
            codes: ['dislike', 'cooking_time'],
            recomputedAt: expect.any(String),
        });
    });

    it('takes a completed plan’s audit record and revision back with it when the next plan fails', async () => {
        const fixture = await seedFlagFixture(USER_ID, 60);
        // A SECOND ACTIVE, UNENDED WEEK, starting the day after the first ends,
        // carrying the same forty-minute milk-and-eggs recipe.
        //
        // `recomputeActivePlanFlags` walks every such plan in start-date order,
        // and a plan's recomputation ENDS with the audit write to
        // `meal_plans.incompatibility_flags`. So failing as the SECOND plan
        // opens is what puts a failure after the FIRST plan's whole write set —
        // its meals' flags, its revision and its audit record — which is the
        // one part of the lifecycle the meal-level fault above cannot reach.
        // It also means this is the only case that exercises the per-plan loop
        // at all: everything else in this file has one plan.
        const upcoming = await makePlan(USER_ID, {
            startDate: addDaysToDayKey(fixture.dayKey, 1),
            dayCount: 1,
            slots: [
                { slot: 'lunch', slot_time: '12:30', recipeVersionId: fixture.slowRecipeVersionId },
            ],
        });
        const upcomingMealId = upcoming.meal_plan_days[0].meal_plan_meals[0].id;

        // One committed save over both weeks, so each plan already carries a
        // flagged meal, a bumped revision and an audit record for the rollback
        // to restore.
        const arranged = await saveAllOk({
            cookingTimeLimitMin: 15,
            timeZone: TIME_ZONE,
            expectedRevision: 1,
        });

        expect(arranged.affectedMealCount).toBe(2);

        const before = await snapshotWorlds([fixture.planId, upcoming.id]);

        expect(await storedIncompatibilityFlags(fixture.planId)).toEqual({
            flaggedMealIds: [fixture.slowMealId],
            codes: ['cooking_time'],
            recomputedAt: expect.any(String),
        });

        const save: JsonBody = {
            diet: 'vegan',
            allergens: ['milk', 'eggs'],
            dislikedFoodIds: [fixture.fastFoodId, fixture.milkFoodId],
            cookingTimeLimitMin: 60,
            timeZone: WESTERN_TIME_ZONE,
            expectedRevision: 2,
        };

        const faulted = await sendUnderSecondPlanRecipeReadFault(() => saveAll(save));

        // TWO PLANS OPENED MEANS THE FIRST ONE FINISHED. The loop only asks for
        // the second plan's recipes after `recomputePlanFlags` has returned for
        // the first, and that function's last statement is the audit write —
        // which ran, because this save moves the breakfast's verdict (proved by
        // the commit below) and the audit write happens whenever any verdict
        // changed.
        expect(faulted.plansOpened).toBe(2);
        expect(faulted.response.status).toBe(500);
        expect(faulted.response.body).toEqual({ error: 'internal_error' });
        expectResidualFaultLogged(faulted.logged, 'preferences.save', PLAN_LOOP_FAULT_MESSAGE);

        // Both weeks, byte for byte — including the first plan's audit record,
        // which still describes the fifteen-minute save rather than the
        // recomputation that was interrupted.
        expect(await snapshotWorlds([fixture.planId, upcoming.id])).toEqual(before);

        // And the identical request, still pinning revision 2, commits both
        // weeks at once.
        const committed = await saveAllOk(save);

        expect(committed.preferences.revision).toBe(3);
        expect(committed.affectedMealCount).toBe(3);
        expect(await storedFlags(fixture.fastMealId)).toEqual(BREAKFAST_DISLIKE_FLAGS);
        expect(await storedFlags(fixture.slowMealId)).toEqual(LUNCH_PREFERENCE_FLAGS);
        expect(await storedFlags(upcomingMealId)).toEqual(LUNCH_PREFERENCE_FLAGS);
        expect(await planRevision(fixture.planId)).toBe(3);
        expect(await planRevision(upcoming.id)).toBe(3);
        expect(await storedIncompatibilityFlags(fixture.planId)).toEqual({
            flaggedMealIds: [fixture.fastMealId, fixture.slowMealId],
            codes: ['diet', 'allergen', 'dislike'],
            recomputedAt: expect.any(String),
        });
        expect(await storedIncompatibilityFlags(upcoming.id)).toEqual({
            flaggedMealIds: [upcomingMealId],
            codes: ['diet', 'allergen', 'dislike'],
            recomputedAt: expect.any(String),
        });
    });
});

/* ---------------------------------------------------------------------------
 * The server-side kill switch
 *
 * `MEAL_PLANNING_ENABLED` gates fifteen of the router's eighteen handlers, and
 * the three exceptions are the target routes (§0.3.1, §0.5.2) because Account,
 * Progress and the Diary target editor read and write through them and must
 * keep working while planning is off. That makes the gate PER HANDLER rather
 * than per router, which is a claim only a request to each side can support.
 * ------------------------------------------------------------------------- */

/** The three preference requests, as thunks, so the gate is asserted over all of them. */
const PREFERENCE_REQUESTS: readonly [string, () => Promise<HttpResponse>][] = [
    ['GET /preferences', () => readPreferences()],
    ['PUT /preferences', () => saveAll({ diet: 'vegan', expectedRevision: 1 })],
    ['PUT /preferences/steps/goal', () => saveStep('goal', goalPayload())],
];

describe('the MEAL_PLANNING_ENABLED gate', () => {
    describe('with the flag off', () => {
        beforeEach(() => {
            mealPlanningEnabled.mockReturnValue(false);
        });

        it.each(PREFERENCE_REQUESTS)(
            'answers 503 feature_disabled to %s',
            async (_label, send) => {
                const response = await send();

                expect(response.status).toBe(503);
                // The machine code the client already maps, and nothing else —
                // the gate is a capability statement, not a validation failure.
                expect(response.body).toEqual({ error: 'feature_disabled' });
            },
        );

        it('refuses before doing any work, so no row is created', async () => {
            await saveStep('goal', goalPayload());

            expect(await storedRow()).toBeNull();
        });

        it('still answers the ungated targets route, which Account and the Diary depend on', async () => {
            // One assertion, deliberately shallow: targets truth belongs to
            // `targets.test.ts`. What is proven here is only that the gate did
            // not take the whole router down with it.
            const response: HttpResponse = await asUser(request.get(TARGETS_PATH), { uid: USER_ID });

            expect(response.status).toBe(200);
        });
    });

    it.each(PREFERENCE_REQUESTS)(
        'answers %s normally while the flag is on',
        async (_label, send) => {
            // Without this contrast the cases above could pass against a
            // permanently disabled feature: they prove the 503 is caused by the
            // flag rather than by the route being broken either way.
            const response = await send();

            expect(response.status).not.toBe(503);
        },
    );
});

/* ---------------------------------------------------------------------------
 * Ownership and the shape of a refusal
 *
 * Identity comes from `getUserId(req)` and from nowhere else (Rule
 * backend-architecture §4), and every write predicate carries the owner key
 * (§5.1). Both are properties of the wiring rather than of a rule, so both are
 * asserted here against two users' rows standing side by side.
 * ------------------------------------------------------------------------- */

/** Every refusal this suite can provoke, for the two claims that hold across all of them. */
const REFUSALS: readonly [string, () => Promise<HttpResponse>][] = [
    ['an unknown step segment', () => saveStep('goals', goalPayload())],
    ['a refused field', () => saveAll({ cookingTimeLimitMin: 37, expectedRevision: 1 })],
    ['a server-owned key', () => saveAll({ revision: 9, expectedRevision: 1 })],
    ['a stale revision', () => saveAll({ diet: 'vegan', expectedRevision: 99 })],
    ['a step against a stale revision', () => saveStep('diet', dietPayload({ expectedRevision: 99 }))],
    ['a missing identity', async () => request.get(PREFERENCES_PATH)],
];

describe('ownership and the shape of a refusal', () => {
    it('writes only the row of the user the header names', async () => {
        await makePreferences(USER_ID, { time_zone: TIME_ZONE, revision: 1 });
        await makePreferences(OTHER_USER_ID, { time_zone: TIME_ZONE, revision: 1 });
        const otherBefore = await storedRowOrThrow(OTHER_USER_ID);

        await saveAllOk({ diet: 'vegan', timeZone: TIME_ZONE, expectedRevision: 1 });
        await saveStepOk('activity', activityPayload({ activityLevel: 'active', expectedRevision: 2 }));

        expect((await storedRowOrThrow()).diet).toBe('vegan');
        expect((await storedRowOrThrow()).activity_level).toBe('active');
        // Byte-identical, not merely "still has a row": an id-only write would
        // leave this row intact in the rows it did not touch and different in
        // the ones it did.
        expect(await storedRowOrThrow(OTHER_USER_ID)).toEqual(otherBefore);
    });

    it('refuses a body that names a user at all, rather than trusting or silently dropping it', async () => {
        // The stronger claim than "ignored": `userId` is not one of the twenty
        // editable keys, so the closed key set refuses it outright — a client
        // cannot express an identity in the body, and nothing has to decide
        // which of two identities wins.
        await makePreferences(USER_ID, { time_zone: TIME_ZONE, revision: 1 });
        await makePreferences(OTHER_USER_ID, { time_zone: TIME_ZONE, revision: 1 });
        const ownBefore = await storedRowOrThrow();
        const otherBefore = await storedRowOrThrow(OTHER_USER_ID);

        const fullSave = await saveAll({
            userId: OTHER_USER_ID,
            diet: 'vegan',
            timeZone: TIME_ZONE,
            expectedRevision: 1,
        });
        const stepSave = await saveStep(
            'diet',
            dietPayload({ userId: OTHER_USER_ID, expectedRevision: 1 }),
        );

        for (const response of [fullSave, stepSave]) {
            expect(response.status).toBe(400);
            expect(detailsOf(response)).toContainEqual({
                field: 'userId',
                code: PREFERENCE_FIELD_CODES.READ_ONLY_FIELD,
            });
        }

        expect(await storedRowOrThrow()).toEqual(ownBefore);
        expect(await storedRowOrThrow(OTHER_USER_ID)).toEqual(otherBefore);
    });

    it('reads only the row of the user the header names', async () => {
        await makePreferences(OTHER_USER_ID, {
            time_zone: TIME_ZONE,
            revision: 4,
            diet: 'pescatarian',
        });

        // A user with no row of their own reads the no-row answer, never a
        // neighbour's: §0.5.2's "no tenant predicate" exemption covers the
        // shared catalog tables and nothing here.
        expect(await readPreferencesOk()).toEqual(NOT_STARTED);
        expect((await readPreferencesOk()).revision).toBe(NO_PREFERENCES_REVISION);
    });

    it.each(REFUSALS)('never answers 403 to %s', async (_label, send) => {
        // §1.5: a cross-user or missing resource is a 404 and an unmet
        // precondition is a 400/409 — 403 would tell an attacker that something
        // exists, so no path in this file may produce one.
        const response = await send();

        expect(response.status).not.toBe(403);
        expect([400, 401, 409]).toContain(response.status);
    });

    it.each(REFUSALS)('leaks nothing internal in the body of %s', async (_label, send) => {
        const response = await send();
        const serialized = JSON.stringify(response.body ?? {});

        // `{error: err}` is the anti-pattern Rule §4 names; these are the traces
        // it leaves. Asserting on the serialized body catches them at any depth.
        for (const trace of ['stack', '\\n    at ', 'prisma', 'meal_plan_preferences', 'node_modules']) {
            expect(serialized).not.toContain(trace);
        }

        // The whole body, key for key: a refusal carries the code the client
        // switches on plus the data it recovers with, and nothing more.
        const keys = Object.keys(response.body as JsonBody);

        expect(keys).toContain('error');
        for (const key of keys) {
            expect(['error', 'details', 'currentRevision']).toContain(key);
        }
    });

    it('rejects a value outside a closed set through the API, which is where the set is enforced', async () => {
        // The schema carries no Prisma enums and no CHECK constraints (§0.5.1):
        // `goal`, `diet` and the rest are plain TEXT, so the API is the ONLY
        // place that refuses an unknown member. Proving it with a raw insert
        // would prove nothing, and would pass against a service that accepted
        // anything.
        await makePreferences(USER_ID, { time_zone: TIME_ZONE, revision: 1 });

        const response = await saveAll({ diet: 'carnivore', timeZone: TIME_ZONE, expectedRevision: 1 });

        expect(response.status).toBe(400);
        expect(fieldsOf(response)).toEqual(['diet']);
        expect((await storedRowOrThrow()).diet).toBe('none');
    });

    it('answers the no-row read for a user whose only plan has ended, without inventing a row', async () => {
        // The one fixture state a preference read can misreport: an ended plan
        // is stored `active`, so `hasActivePlan` must come from the date rule
        // and not from the status column alone (§0.5.1).
        await makePlan(USER_ID, { startDate: FIXTURE_ENDED_PLAN_START_DAY_KEY, dayCount: 1 });

        expect(await readPreferencesOk()).toEqual(NOT_STARTED);
        expect(await storedRow()).toBeNull();
    });
});
