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
//    how they come to disagree.
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

import { prisma } from '../../prisma/client';
import { NO_PREFERENCES_REVISION, PREFERENCE_FIELD_CODES } from '../../services/preferences.logic';
import { MealFlag, PreferencesResponse, PreferencesSaveResponse } from '../../types/mealPlanning';
import { isMealPlanningEnabled } from '../../utils/featureFlags';
import {
    FIXTURE_ENDED_PLAN_START_DAY_KEY,
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
            // £42 a week over four meals a day is 1.50 a meal, which is tier 1.
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

    describe('a refused save is one transaction that wrote nothing', () => {
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
    /** That lunch's recipe, so a second plan can carry the same conflict. */
    slowRecipeVersionId: string;
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
        dayCount: 1,
        slots: [
            { slot: 'breakfast', slot_time: '08:00', recipeVersionId: fast.id },
            { slot: 'lunch', slot_time: '12:30', recipeVersionId: slow.id },
        ],
    });

    const meals = plan.meal_plan_days[0].meal_plan_meals;
    const fastMeal = meals.find((meal) => meal.slot === 'breakfast');
    const slowMeal = meals.find((meal) => meal.slot === 'lunch');

    if (fastMeal === undefined || slowMeal === undefined) {
        throw new Error('the flag fixture did not plan both of its slots');
    }

    return {
        planId: plan.id,
        dayKey,
        fastMealId: fastMeal.id,
        slowMealId: slowMeal.id,
        slowRecipeVersionId: slow.id,
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
