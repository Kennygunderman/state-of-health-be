// The HTTP boundary of `GET /api/recipes/:recipeVersionId`, against a real
// PostgreSQL (Agent Action Plan §0.5.2 for the contract, §0.9.2's recipe-
// visibility and ownership rows, and Rule 7 §1.5/§3.1/§4/§5.1/§6/§8/§11).
//
// FOUR PROPERTIES LIVE HERE, and each one needs a database to establish:
//
//  1. THE VISIBILITY RULE, at the boundary. A recipe version is shared
//     reference data while it is `current` and becomes CALLER-SCOPED once it is
//     `retired`: visible then only to a user who holds one of three references
//     to it. That makes this the subtlest tenancy decision in the feature, and
//     the only place it is observable as a status code is here.
//  2. THE FROZEN SNAPSHOT. An ingredient's displayed name and provenance come
//     from the `recipe_ingredients.snapshot_*` columns, never from the live
//     `catalog_foods` row, and `perServing` reads the stored `per_serving_*`
//     columns rather than being recomputed. A regression to reading the live
//     row type-checks perfectly and can only be caught by a version whose
//     snapshot deliberately DISAGREES with the food it points at, which is what
//     the `diverging` fixture below is.
//  3. THE WIRE SHAPE. `recipe.mapper.ts` states in its own header that
//     "§11 covers mappers by integration — `src/__tests__/api/recipes.test.ts`
//     … assert these shapes end to end", so the whole `RecipeVersionResponse`
//     projection, including the closed code sets, is this file's to pin.
//  4. THE FLAG GATE. `/recipes/*` answers `503 feature_disabled` while meal
//     planning is off. The handler resolves its caller first and checks the
//     gate immediately after (Rule 7 §4's identity-first sequence), so the
//     refusal still lands BEFORE the parser and BEFORE the lookup — otherwise
//     it would reveal what exists — while authentication, being a mount-order
//     concern rather than a handler one, still precedes both.
//
// WHAT IS DELIBERATELY NOT HERE. Every recipe RULE —
// `deriveRecipeNutrition`, `deriveBadges`, `deriveDietTags`/
// `deriveAllergenTags`, `scaleIngredients`, `isEligibleForPlanning`,
// `isIngredientSnapshotStale`, the closed-set guards — belongs to
// `src/services/__tests__/recipe.logic.test.ts`, which tests them with no
// database at all. The question every case below had to pass is Rule 7 §11's:
// could this pass with the database stubbed out? If it could, it is a rule and
// it lives there. `src/__tests__/api/ownership.test.ts` covers the same
// visibility rule one layer down, as `getRecipeVersionForUser` returning `null`;
// what this file adds is that the `null` becomes a 404 whose body is
// indistinguishable from every other 404 — and the `previous_recipe_version_id`
// reference arm, which that suite does not reach.
//
// HOW IT IS DRIVEN. Only through `request` from `../setup/testApp`, which wraps
// the shipped `app`, so the mount order in `app.ts` — and with it the fact that
// this router sits AFTER `app.use(authenticateFirebaseToken)` (Rule 7 §3.1) — is
// inherited rather than reconstructed. Identity arrives only in the
// `x-test-user-id` header, the request's authentication channel, so a handler
// still learns its caller through `getUserId(req)` alone (§4) and "another
// user's id" keeps its meaning. Rows are seeded through the factories and, where
// no factory covers the shape, through the shared Prisma singleton in
// snake_case (§10) — never through an application service, so no case depends
// on the code it is testing to build its own input.
//
// DETERMINISM. No clock read and no random value: every id that has to name
// nothing is a fixed UUID literal, every seeded week names its `startDate`, and
// every nutrition figure is chosen to be exact in binary so a float comparison
// cannot flake.

import { prisma } from '../../prisma/client';
import { RECIPE_FIELD_CODES } from '../../services/recipe.logic';
import { MEAL_SLOTS, RECIPE_BADGES, RECIPE_ICON_KEYS, RecipeVersionResponse } from '../../types/recipe';
import { isMealPlanningEnabled } from '../../utils/featureFlags';
import {
    FIXTURE_ENDED_PLAN_START_DAY_KEY,
    FixtureRecipeVersion,
    makeCatalogFood,
    makePlan,
    makeRecipeVersion,
    makeUser,
} from '../setup/factories';
import { asUser, request } from '../setup/testApp';
import { truncateFeatureTables } from '../setup/testDb';

// The gate cannot be flipped through `process.env`: `featureFlags.ts` resolves
// `MEAL_PLANNING_ENABLED` once, at import, into a `const` behind an accessor —
// which is Rule 7 §9's "read config once, at the top of the module", and is why
// a mid-suite environment edit would be read by nothing. So the accessor itself
// is replaced, and only that one: `requireActual` keeps `mealPlanningFault`,
// `postCommitAbort` and `POST_COMMIT_ABORT_HEADER` real for the other routers
// `app.ts` mounts, so this file changes exactly the switch it is testing.
jest.mock('../../utils/featureFlags', () => ({
    ...jest.requireActual<typeof import('../../utils/featureFlags')>('../../utils/featureFlags'),
    isMealPlanningEnabled: jest.fn(() => true),
}));

const mealPlanningEnabled = jest.mocked(isMealPlanningEnabled);

/* ---------------------------------------------------------------------------
 * Ids that name nothing, and ids that cannot name anything
 * ------------------------------------------------------------------------- */

/**
 * Well-formed v4 UUIDs that no row carries. Fixed literals rather than
 * `randomUUID()`: nothing asserts on their value, so randomness would buy
 * nothing and cost the determinism Rule 4 asks for.
 */
const UNKNOWN_VERSION_ID = 'aaaaaaaa-0000-4000-8000-000000000001';
const SECOND_UNKNOWN_VERSION_ID = 'aaaaaaaa-0000-4000-8000-000000000002';

/**
 * Segments that cannot denote a version, chosen for what they prove AT THE
 * BOUNDARY rather than for parser coverage: each is an odd-looking path segment,
 * so a JSON 400 from this handler also establishes that Express still matched
 * the parameterized route instead of falling through to its own HTML 404.
 *
 * The exhaustive shape coverage — wrong version nibble, wrong variant nibble,
 * absent value — is a parser RULE and lives in
 * `src/services/__tests__/recipe.logic.test.ts`, which needs no database for it;
 * and that the refusal happens with NO database call is proved at the controller
 * by `src/__tests__/api/requestParserWiring.test.ts`. Restating either here
 * would be a third suite asserting one thing.
 *
 * None contains a slash, which would change which route matched and prove
 * nothing about this one.
 */
const MALFORMED_VERSION_IDS: readonly string[] = [
    'not-a-uuid',
    '123',
    '{aaaaaaaa-0000-4000-8000-000000000001}',
];

/**
 * A valid v4 UUID in upper case. The parser's pattern is case-insensitive, so
 * this is the boundary between the two refusals: it is well formed, names
 * nothing, and must therefore be the route's 404 rather than its 400.
 */
const UPPERCASE_UNKNOWN_VERSION_ID = 'AAAAAAAA-0000-4000-8000-000000000003';

/* ---------------------------------------------------------------------------
 * The one request this suite makes
 * ------------------------------------------------------------------------- */

const recipePath = (recipeVersionId: string): string => `/api/recipes/${recipeVersionId}`;

/** The route as an authenticated caller reaches it. */
const getRecipe = (userId: string, recipeVersionId: string) =>
    asUser(request.get(recipePath(recipeVersionId)), { uid: userId });

/** The same route with no identity at all — the pre-controller boundary. */
const getRecipeUnauthenticated = (recipeVersionId: string) => request.get(recipePath(recipeVersionId));

/* ---------------------------------------------------------------------------
 * Shared expectations, kept in this file
 * ------------------------------------------------------------------------- */
// Rule 7 §7.1's anti-ceremony clause cuts both ways: these are worth naming
// because several cases assert the same property, and they stay here because
// `__tests__/setup` is shared infrastructure and a helper only this suite uses
// does not belong in it.

/**
 * Every key anywhere in a decoded response body, including inside arrays and
 * nested objects.
 *
 * The scope and hygiene assertions are claims about the WHOLE body — "no
 * planned-meal context anywhere", "no snake_case anywhere" — and a check on the
 * top level only would miss exactly the place such a field would appear, on an
 * ingredient row.
 */
const collectKeysDeep = (value: unknown, keys: Set<string> = new Set()): Set<string> => {
    if (Array.isArray(value)) {
        for (const member of value) {
            collectKeysDeep(member, keys);
        }

        return keys;
    }

    if (typeof value === 'object' && value !== null) {
        for (const [key, member] of Object.entries(value)) {
            keys.add(key);
            collectKeysDeep(member, keys);
        }
    }

    return keys;
};

/**
 * Asserts an error body carries the contract's members and nothing else.
 *
 * Rule 7 §4 names `{ error: err }` as the pattern to fix rather than follow, so
 * what is checked is not only which keys are present but what the serialised
 * body could betray: a stack frame, a Prisma error, an exception message, or the
 * internal diagnostics `RecipeMappingError` and the path parser write for the
 * operator. The mapper's message, for instance, names the offending column and
 * row — useful in a log, and nothing a client may see.
 */
const expectSafeErrorBody = (body: unknown, allowedKeys: readonly string[]): void => {
    expect(typeof body).toBe('object');
    expect(body).not.toBeNull();
    expect(Object.keys(body as Record<string, unknown>).sort()).toEqual([...allowedKeys].sort());

    const serialised = JSON.stringify(body);

    for (const leak of [
        'stack',
        'at Object',
        'PrismaClient',
        'prisma',
        'Invalid `',
        'RecipeMappingError',
        'recipe_versions',
        'recipe_ingredients',
        'catalog_foods',
        'node_modules',
        // The parser's own server-side diagnostic. `details` is what the client
        // renders; the sentence is for the log.
        'invalid recipe version path',
    ]) {
        expect(serialised).not.toContain(leak);
    }
};

/** The 404 every refusal on this route shares. */
const expectNotFound = (status: number, body: unknown): void => {
    expect(status).toBe(404);
    expectSafeErrorBody(body, ['error']);
};

/** The 400 the path parser produces, with the field and code it names. */
const expectInvalidId = (status: number, body: unknown): void => {
    expect(status).toBe(400);
    expectSafeErrorBody(body, ['error', 'details']);
    expect(body).toEqual({
        error: 'invalid_request',
        // Imported rather than written out, so the assertion follows the wire
        // vocabulary if it is ever extended.
        details: [{ field: 'recipeVersionId', code: RECIPE_FIELD_CODES.INVALID_ID }],
    });
};

/* ---------------------------------------------------------------------------
 * Fixtures
 * ------------------------------------------------------------------------- */

/**
 * The per-100 g figures and gram weights below are chosen so every derived
 * value is exact in binary: each `gram_weight × per-100 g ÷ 100` term is a whole
 * number, their sums are whole, and the division by the yield lands on a
 * half-power of two. A float comparison on `perServing` is therefore a real
 * assertion rather than a flake waiting for a different machine.
 */
const RICH_YIELD_SERVINGS = 4;

/** Σ = 1050 / 92 / 106 / 21 over the three ingredients; ÷ 4 servings. */
const RICH_PER_SERVING = { calories: 262.5, protein: 23, carbs: 26.5, fat: 5.25 };

/** The same totals before the division, which is what a yield bug would emit. */
const RICH_RECIPE_TOTALS = { calories: 1050, protein: 92, carbs: 106, fat: 21 };

const RICH_INSTRUCTIONS = [
    'Heat the oven to 200°C.',
    'Toss everything with the oil and roast for 18 minutes.',
    'Finish with lemon and serve.',
];

/** A `current` version with nothing unusual about it. */
const seedCurrentVersion = (sequence: number): Promise<FixtureRecipeVersion> =>
    makeRecipeVersion({ sequence, slug: `recipes-suite-current-${sequence}` });

/** A `retired` version: readable only through a reference of the caller's own. */
const seedRetiredVersion = (sequence: number): Promise<FixtureRecipeVersion> =>
    makeRecipeVersion({ sequence, slug: `recipes-suite-retired-${sequence}`, status: 'retired' });

/**
 * A version that exercises every member of the response at a distinguishable
 * value: a yield above one, three ingredients at different gram weights with the
 * last one optional, a multi-step instruction list, and a code in each closed
 * set that is not the factory's default.
 */
const seedRichVersion = async (sequence: number): Promise<FixtureRecipeVersion> => {
    const primary = await makeCatalogFood({ sequence, display_name: 'Chicken breast, cooked' });
    const secondary = await makeCatalogFood({
        sequence: sequence + 1,
        display_name: 'Brown rice, cooked',
    });
    const optional = await makeCatalogFood({ sequence: sequence + 2, display_name: 'Feta' });

    return makeRecipeVersion({
        sequence,
        slug: `recipes-suite-rich-${sequence}`,
        catalogFoodId: primary.id,
        name: 'Chicken burrito bowl',
        description: 'A bowl that carries every field this contract declares.',
        icon_key: 'pot',
        instructions: RICH_INSTRUCTIONS,
        yield_servings: RICH_YIELD_SERVINGS,
        serving_description: '1 bowl',
        prep_minutes: 12,
        cook_minutes: 18,
        meal_slots: ['lunch', 'dinner', 'snack'],
        diet_tags: ['pescatarian'],
        allergen_tags: ['milk'],
        allergen_status: 'known',
        budget_tier: 2,
        badges: ['high_protein', 'gluten_free'],
        ingredients: [
            {
                catalogFoodId: primary.id,
                per100g: { calories: 200, protein_g: 20, carbs_g: 10, fat_g: 4, fiber_g: 2 },
                gram_weight: 400,
                quantity: 14,
                unit: 'oz',
                display_text: '14 oz',
                snapshot_name: 'Chicken breast, cooked',
            },
            {
                catalogFoodId: secondary.id,
                per100g: { calories: 100, protein_g: 5, carbs_g: 30, fat_g: 2, fiber_g: 1 },
                gram_weight: 200,
                quantity: 1,
                unit: 'cup',
                display_text: '1 cup',
                snapshot_name: 'Brown rice, cooked',
            },
            {
                catalogFoodId: optional.id,
                per100g: { calories: 50, protein_g: 2, carbs_g: 6, fat_g: 1, fiber_g: 0 },
                gram_weight: 100,
                quantity: 3.5,
                unit: 'oz',
                display_text: '3½ oz',
                snapshot_name: 'Feta',
                snapshot_allergen_tags: ['milk'],
                snapshot_diet_tags: ['pescatarian'],
                is_optional: true,
            },
        ],
    });
};

/* ---------------------------------------------------------------------------
 * The divergence fixture — a snapshot that disagrees with its own food
 * ------------------------------------------------------------------------- */

/**
 * What the ingredient's food looks like TODAY, after a catalog refresh renamed
 * it and re-derived its nutrition as an estimate. None of these values may
 * reach the response.
 */
const LIVE_FOOD = {
    displayName: 'Greek yogurt, plain',
    provenance: 'ai_estimated',
    per100g: { calories: 150, protein_g: 15, carbs_g: 20, fat_g: 2 },
};

/**
 * What the recipe FROZE about that food when it was published — a different
 * name, a stronger provenance, and different nutrition. Every one of these is
 * what the response must carry.
 */
const FROZEN_SNAPSHOT = {
    name: 'Yogurt, Greek, plain, nonfat',
    provenance: 'source_backed',
    per100g: { calories: 400, protein_g: 40, carbs_g: 8, fat_g: 12, fiber_g: 0 },
    gramWeight: 200,
};

const DIVERGING_YIELD_SERVINGS = 2;

/** 200 g × the frozen per-100 g values, over two servings. */
const SNAPSHOT_DERIVED_PER_SERVING = { calories: 400, protein: 40, carbs: 8, fat: 12 };

/**
 * The same arithmetic over the LIVE row: what a regression that joined
 * `catalog_foods` instead of reading the snapshot would report. Asserted as an
 * inequality so the case cannot pass by the two happening to coincide.
 */
const LIVE_DERIVED_PER_SERVING = { calories: 150, protein: 15, carbs: 20, fat: 2 };

interface DivergingFixture {
    version: FixtureRecipeVersion;
    catalogFoodId: string;
}

/**
 * A `current` version whose one ingredient's snapshot columns deliberately
 * disagree with the live `catalog_foods` row they point at, in all three
 * respects the response exposes: the displayed name, the provenance code, and
 * the nutrition the stored `per_serving_*` columns were derived from.
 *
 * This is the only shape that can catch a regression to reading the live row:
 * with an ordinary fixture the snapshot and the food agree, so both the correct
 * read and the incorrect one produce the same body and the test passes either
 * way.
 *
 * `publicationStatus` lets the same fixture cover the other half of the
 * retired-catalog asymmetry `api/catalog.test.ts` asserts — a retired food is
 * invisible to SEARCH and still referenceable by a published recipe.
 */
const seedDivergingVersion = async (
    sequence: number,
    publicationStatus: string = 'published',
): Promise<DivergingFixture> => {
    const food = await makeCatalogFood({
        sequence,
        display_name: LIVE_FOOD.displayName,
        nutrition_provenance: LIVE_FOOD.provenance,
        publication_status: publicationStatus,
        nutrition_version: 2,
        metadata_version: 2,
        ...LIVE_FOOD.per100g,
    });

    const version = await makeRecipeVersion({
        sequence,
        slug: `recipes-suite-diverging-${sequence}`,
        catalogFoodId: food.id,
        name: 'Greek yogurt bowl',
        yield_servings: DIVERGING_YIELD_SERVINGS,
        ingredients: [
            {
                catalogFoodId: food.id,
                per100g: FROZEN_SNAPSHOT.per100g,
                gram_weight: FROZEN_SNAPSHOT.gramWeight,
                quantity: 2,
                unit: 'cup',
                display_text: '2 cups',
                snapshot_name: FROZEN_SNAPSHOT.name,
                snapshot_provenance: FROZEN_SNAPSHOT.provenance,
            },
        ],
    });

    return { version, catalogFoodId: food.id };
};

/* ---------------------------------------------------------------------------
 * The three references that make a retired version visible
 * ------------------------------------------------------------------------- */

/**
 * A week that has already finished. Chosen deliberately: the reference check
 * filters on the owner and the recipe id and on NOTHING about the plan's dates
 * or status, because a historical plan must keep resolving its recipes. Seeding
 * the references on a finished week proves that rather than assuming it, and it
 * keeps the fixture clock-free.
 */
const REFERENCE_WEEK_START = FIXTURE_ENDED_PLAN_START_DAY_KEY;

/** A second, non-overlapping week, for a case that needs two plans of one user. */
const SECOND_REFERENCE_WEEK_START = '2026-07-12';

/** The diary day the entry-backed references are logged on. */
const DIARY_DAY_KEY = '2026-07-05';

const toUtcMidnight = (dayKey: string): Date => new Date(`${dayKey}T00:00:00.000Z`);

/** One planned dinner, which is all a reference needs. */
const DINNER_SLOT = [{ slot: 'dinner', slot_time: '18:30' }] as const;

/**
 * Reference 1 — the version is the recipe a meal of this user's plan currently
 * plans.
 */
const linkPlannedRecipe = async (
    userId: string,
    recipeVersionId: string,
    startDate: string = REFERENCE_WEEK_START,
): Promise<void> => {
    await makePlan(userId, {
        startDate,
        dayCount: 1,
        recipeVersionId,
        slots: DINNER_SLOT,
    });
};

/**
 * Reference 2 — the version is what a meal of this user's plan was BEFORE a
 * swap, which is the state the plan card's logged-then-swapped caption names.
 *
 * The meal's current recipe is a different version, so the first reference
 * clause cannot be what grants visibility here and this arm is exercised on its
 * own. The update is keyed on `(id, user_id)`, so a fixture that had wired the
 * meal to the wrong owner would fail here rather than silently prove the wrong
 * thing.
 */
const linkPreviousRecipe = async (
    userId: string,
    currentRecipeVersionId: string,
    previousRecipeVersionId: string,
    startDate: string = REFERENCE_WEEK_START,
): Promise<void> => {
    const plan = await makePlan(userId, {
        startDate,
        dayCount: 1,
        recipeVersionId: currentRecipeVersionId,
        slots: DINNER_SLOT,
    });

    const meal = plan.meal_plan_days[0].meal_plan_meals[0];

    await prisma.meal_plan_meals.update({
        where: { id_user_id: { id: meal.id, user_id: userId } },
        data: {
            previous_recipe_version_id: previousRecipeVersionId,
            swapped_at: toUtcMidnight(DIARY_DAY_KEY),
        },
    });
};

/**
 * Reference 3 — a diary entry of this user's points at the version.
 *
 * Written directly, because this is the one reference class no service path can
 * produce in isolation: the entry has to reference the version while NO plan of
 * the caller's does, or the planned-meal clause would be what makes it visible.
 * It is the shape a real entry takes once the meal it was logged from has been
 * regenerated away — and `deleted` is the same shape after the user removed the
 * entry, which the service treats as no reference at all.
 */
const linkDiaryEntry = async (
    userId: string,
    version: FixtureRecipeVersion,
    { deleted = false }: { deleted?: boolean } = {},
): Promise<void> => {
    const date = toUtcMidnight(DIARY_DAY_KEY);

    const meal = await prisma.meals.create({
        data: { user_id: userId, date, name: 'Dinner', sort_order: 2 },
    });

    await prisma.meal_entries.create({
        data: {
            meal_id: meal.id,
            user_id: userId,
            date,
            name: version.name,
            serving_text: version.serving_description,
            servings: 1,
            calories: Math.round(version.per_serving_calories),
            protein_g: Math.round(version.per_serving_protein_g),
            carbs_g: Math.round(version.per_serving_carbs_g),
            fat_g: Math.round(version.per_serving_fat_g),
            input_method: 'meal_plan',
            nutrition_provenance: 'source_backed',
            recipe_version_id: version.id,
            deleted_at: deleted ? toUtcMidnight(DIARY_DAY_KEY) : null,
        },
    });
};

/* ---------------------------------------------------------------------------
 * Lifecycle
 * ------------------------------------------------------------------------- */

let owner: string;
let stranger: string;

beforeEach(async () => {
    await truncateFeatureTables();

    // `clearMocks` clears a mock's CALLS, not a `mockReturnValue` set on it, so
    // the gate is restored explicitly here rather than left to the runner. The
    // flag describe's own `beforeEach` runs after this one and turns it off.
    mealPlanningEnabled.mockReturnValue(true);

    owner = (await makeUser()).id;
    stranger = (await makeUser()).id;
});

afterAll(async () => {
    mealPlanningEnabled.mockReturnValue(true);
    await truncateFeatureTables();
});

/* ---------------------------------------------------------------------------
 * A current version belongs to nobody
 * ------------------------------------------------------------------------- */

describe('a current version is shared reference data', () => {
    it('resolves for the caller whose plan uses it and for a caller with nothing at all', async () => {
        const version = await seedCurrentVersion(1);
        await linkPlannedRecipe(owner, version.id);

        const asOwner = await getRecipe(owner, version.id);
        const asStranger = await getRecipe(stranger, version.id);

        expect(asOwner.status).toBe(200);
        expect(asStranger.status).toBe(200);
        // Byte-identical, not merely both-200: a per-caller difference on a
        // tenant-less read would be the first sign of a user-scoped predicate
        // creeping into it.
        expect(asStranger.body).toEqual(asOwner.body);
        expect((asOwner.body as RecipeVersionResponse).versionId).toBe(version.id);
    });

    it('reports its status, so a client can tell a published recipe from a historical one', async () => {
        const version = await seedCurrentVersion(1);

        const response = await getRecipe(stranger, version.id);

        expect(response.status).toBe(200);
        expect((response.body as RecipeVersionResponse).status).toBe('current');
    });

    it('resolves a second version of the same recipe once the first has been retired', async () => {
        // Exactly one version per recipe may be `current` — a partial unique
        // index enforces it — so this is the only shape two versions of one
        // recipe can take, and both must resolve for their own reasons: the
        // current one because it is published, the retired one because the
        // caller's plan still references it.
        const first = await makeRecipeVersion({ sequence: 1, slug: 'recipes-suite-two-versions' });
        await prisma.recipe_versions.update({
            where: { id: first.id },
            data: { status: 'retired', retired_at: toUtcMidnight(DIARY_DAY_KEY) },
        });
        const second = await makeRecipeVersion({
            sequence: 2,
            recipeId: first.recipe_id,
            version: 2,
        });
        await linkPlannedRecipe(owner, first.id);

        const retired = await getRecipe(owner, first.id);
        const current = await getRecipe(owner, second.id);

        expect(retired.status).toBe(200);
        expect((retired.body as RecipeVersionResponse).status).toBe('retired');
        expect(current.status).toBe(200);
        expect((current.body as RecipeVersionResponse).status).toBe('current');
        expect((current.body as RecipeVersionResponse).recipeId).toBe(
            (retired.body as RecipeVersionResponse).recipeId,
        );
    });
});

/* ---------------------------------------------------------------------------
 * The wire shape
 * ------------------------------------------------------------------------- */

/**
 * The whole response for {@link seedRichVersion}, written out.
 *
 * ANNOTATED `RecipeVersionResponse` ON PURPOSE. That makes the compiler the
 * first line of defence for "assert every declared member": a member added to
 * the contract stops this builder compiling until it is asserted here, and a
 * member removed or renamed does the same. An `as` cast or a loose object would
 * let the DTO grow a field that nothing in this suite ever looked at.
 */
const expectedRichBody = (version: FixtureRecipeVersion): RecipeVersionResponse => {
    const [primary, secondary, optional] = version.recipe_ingredients;

    return {
        versionId: version.id,
        recipeId: version.recipe_id,
        version: 1,
        status: 'current',
        name: 'Chicken burrito bowl',
        description: 'A bowl that carries every field this contract declares.',
        iconKey: 'pot',
        instructions: RICH_INSTRUCTIONS,
        yieldServings: RICH_YIELD_SERVINGS,
        servingDescription: '1 bowl',
        prepMinutes: 12,
        cookMinutes: 18,
        // Derived at publication, never an independently authoritative field.
        totalMinutes: 30,
        mealSlots: ['lunch', 'dinner', 'snack'],
        badges: ['high_protein', 'gluten_free'],
        dietTags: ['pescatarian'],
        allergenTags: ['milk'],
        allergenStatus: 'known',
        budgetTier: 2,
        nutritionProvenance: 'source_backed',
        perServing: RICH_PER_SERVING,
        // Whole-recipe amounts, never scaled to a portion.
        ingredients: [
            {
                catalogFoodId: primary.catalog_food_id,
                name: 'Chicken breast, cooked',
                quantity: 14,
                unit: 'oz',
                gramWeight: 400,
                displayText: '14 oz',
                nutritionProvenance: 'source_backed',
                isOptional: false,
            },
            {
                catalogFoodId: secondary.catalog_food_id,
                name: 'Brown rice, cooked',
                quantity: 1,
                unit: 'cup',
                gramWeight: 200,
                displayText: '1 cup',
                nutritionProvenance: 'source_backed',
                isOptional: false,
            },
            {
                catalogFoodId: optional.catalog_food_id,
                name: 'Feta',
                quantity: 3.5,
                unit: 'oz',
                gramWeight: 100,
                displayText: '3½ oz',
                nutritionProvenance: 'source_backed',
                isOptional: true,
            },
        ],
    };
};

describe('the RecipeVersionResponse shape', () => {
    it('carries every declared member and nothing beyond them', async () => {
        const version = await seedRichVersion(10);

        const response = await getRecipe(owner, version.id);

        expect(response.status).toBe(200);
        expect(response.body).toEqual(expectedRichBody(version));
    });

    it('reports per-serving nutrition, not the whole recipe’s totals', async () => {
        // The fixture yields four servings, so the two differ by a factor of
        // four and a divisor bug cannot hide.
        const version = await seedRichVersion(10);

        const response = await getRecipe(owner, version.id);
        const body = response.body as RecipeVersionResponse;

        expect(body.perServing).toEqual(RICH_PER_SERVING);
        expect(body.perServing).not.toEqual(RICH_RECIPE_TOTALS);
        expect(body.yieldServings).toBe(RICH_YIELD_SERVINGS);
    });

    it('reports the stored per-serving columns rather than a second derivation', async () => {
        const version = await seedRichVersion(10);
        const stored = await prisma.recipe_versions.findUniqueOrThrow({
            where: { id: version.id },
            select: {
                per_serving_calories: true,
                per_serving_protein_g: true,
                per_serving_carbs_g: true,
                per_serving_fat_g: true,
                total_minutes: true,
            },
        });

        const response = await getRecipe(owner, version.id);
        const body = response.body as RecipeVersionResponse;

        expect(body.perServing).toEqual({
            calories: stored.per_serving_calories,
            protein: stored.per_serving_protein_g,
            carbs: stored.per_serving_carbs_g,
            fat: stored.per_serving_fat_g,
        });
        expect(body.totalMinutes).toBe(stored.total_minutes);
    });

    it('lists ingredients in sort_order rather than in the order they were inserted', async () => {
        const version = await seedRichVersion(10);
        const inserted = version.recipe_ingredients;

        // The two orders are made to DISAGREE: with `sort_order` reversed, the
        // insertion order a scan would happen to produce is now the wrong
        // answer, so only an ORDER BY can pass. An instruction step that says
        // "the second ingredient" depends on this.
        for (const [index, ingredient] of inserted.entries()) {
            await prisma.recipe_ingredients.update({
                where: { id: ingredient.id },
                data: { sort_order: inserted.length - 1 - index },
            });
        }

        const response = await getRecipe(owner, version.id);
        const body = response.body as RecipeVersionResponse;

        expect(inserted.map((ingredient) => ingredient.sort_order)).toEqual([0, 1, 2]);
        expect(body.ingredients.map((ingredient) => ingredient.catalogFoodId)).toEqual(
            [...inserted].reverse().map((ingredient) => ingredient.catalog_food_id),
        );
    });

    it('breaks a shared sort_order on catalog_food_id, so the list is totally ordered', async () => {
        // `sort_order` is not unique, so without a tiebreaker two ingredients
        // sharing one would come back in whatever order the scan produced and
        // could swap between requests.
        const version = await seedRichVersion(10);
        await prisma.recipe_ingredients.updateMany({
            where: { recipe_version_id: version.id },
            data: { sort_order: 0 },
        });
        // Postgres orders `uuid` by its bytes, which for the lowercase
        // canonical form is the same as ordering the strings.
        const expectedOrder = version.recipe_ingredients
            .map((ingredient) => ingredient.catalog_food_id)
            .sort();

        const first = await getRecipe(owner, version.id);
        const second = await getRecipe(owner, version.id);

        expect((first.body as RecipeVersionResponse).ingredients.map((i) => i.catalogFoodId)).toEqual(
            expectedOrder,
        );
        expect((second.body as RecipeVersionResponse).ingredients).toEqual(
            (first.body as RecipeVersionResponse).ingredients,
        );
    });

    it('keeps an optional ingredient in the list, flagged rather than dropped', async () => {
        // Whether an optional ingredient counts toward a DERIVATION is
        // `recipe.logic.ts`'s business; that it is still served is this
        // contract's, because a client that could not see it would imply the
        // recipe requires something it merely allows.
        const version = await seedRichVersion(10);

        const response = await getRecipe(owner, version.id);
        const body = response.body as RecipeVersionResponse;

        expect(body.ingredients).toHaveLength(3);
        expect(body.ingredients.filter((ingredient) => ingredient.isOptional)).toEqual([
            expect.objectContaining({ name: 'Feta', isOptional: true }),
        ]);
    });

    it('travels an empty description as an empty string, not as null', async () => {
        // The column is nullable and the contract is not: an empty description
        // renders exactly what null rendered, so the client never branches.
        const version = await makeRecipeVersion({
            sequence: 11,
            slug: 'recipes-suite-no-description',
            description: null,
        });

        const response = await getRecipe(owner, version.id);
        const body = response.body as RecipeVersionResponse;

        expect(response.status).toBe(200);
        expect(body.description).toBe('');
    });
});

/* ---------------------------------------------------------------------------
 * The frozen snapshot
 * ------------------------------------------------------------------------- */

describe('the frozen ingredient snapshot', () => {
    it('reports the name and provenance the recipe was published with, not the food’s current ones', async () => {
        const { version, catalogFoodId } = await seedDivergingVersion(20);

        const response = await getRecipe(owner, version.id);
        const [ingredient] = (response.body as RecipeVersionResponse).ingredients;

        expect(response.status).toBe(200);
        expect(ingredient.name).toBe(FROZEN_SNAPSHOT.name);
        expect(ingredient.nutritionProvenance).toBe(FROZEN_SNAPSHOT.provenance);
        // The inequalities are the point: without them this case would pass
        // against a mapper that read the live row, because an ordinary fixture's
        // snapshot and food agree.
        expect(ingredient.name).not.toBe(LIVE_FOOD.displayName);
        expect(ingredient.nutritionProvenance).not.toBe(LIVE_FOOD.provenance);
        // Only the DISPLAYED facts are frozen. The id still points at the live
        // food, because the client needs it for provenance display and it is the
        // grocery list's canonical identity.
        expect(ingredient.catalogFoodId).toBe(catalogFoodId);
    });

    it('reports nutrition derived from the snapshot, not from the live food', async () => {
        const { version } = await seedDivergingVersion(20);

        const response = await getRecipe(owner, version.id);
        const body = response.body as RecipeVersionResponse;

        expect(body.perServing).toEqual(SNAPSHOT_DERIVED_PER_SERVING);
        expect(body.perServing).not.toEqual(LIVE_DERIVED_PER_SERVING);
    });

    it('still resolves, and still names its ingredient, after that food has been retired', async () => {
        // The other half of the asymmetry `api/catalog.test.ts` asserts: a
        // retired food leaves SEARCH and stays referenceable, so a published
        // recipe built on it does not decay into a 404 or an unnamed row.
        const { version, catalogFoodId } = await seedDivergingVersion(20, 'retired');

        const response = await getRecipe(owner, version.id);
        const [ingredient] = (response.body as RecipeVersionResponse).ingredients;

        expect(response.status).toBe(200);
        expect(ingredient.name).toBe(FROZEN_SNAPSHOT.name);
        expect(ingredient.catalogFoodId).toBe(catalogFoodId);
        expect(
            await prisma.catalog_foods.findUniqueOrThrow({
                where: { id: catalogFoodId },
                select: { publication_status: true },
            }),
        ).toEqual({ publication_status: 'retired' });
    });

    it('reports whole-recipe ingredient amounts, leaving the portion to the caller', async () => {
        // `quantity`, `gramWeight` and `displayText` are the recipe as
        // published, which yields `yieldServings` servings — a recipe response
        // carries no portion, so it cannot be pre-scaled here.
        const { version } = await seedDivergingVersion(20);

        const response = await getRecipe(owner, version.id);
        const body = response.body as RecipeVersionResponse;
        const [ingredient] = body.ingredients;

        expect(ingredient.gramWeight).toBe(FROZEN_SNAPSHOT.gramWeight);
        expect(ingredient.quantity).toBe(2);
        expect(ingredient.displayText).toBe('2 cups');
        expect(body.yieldServings).toBe(DIVERGING_YIELD_SERVINGS);
    });
});

/* ---------------------------------------------------------------------------
 * Codes, never prose
 * ------------------------------------------------------------------------- */

describe('the closed code sets', () => {
    it('emits an icon key, badges and slots drawn from the declared sets', async () => {
        // Membership against the imported `as const` arrays rather than against
        // literals, so the assertion tracks the sets if they are extended. The
        // backend is their only enforcement point — the mobile codecs decode
        // both leniently — which is why this is asserted on the wire.
        const version = await seedRichVersion(30);

        const response = await getRecipe(owner, version.id);
        const body = response.body as RecipeVersionResponse;

        expect(RECIPE_ICON_KEYS).toContain(body.iconKey);
        for (const badge of body.badges) {
            expect(RECIPE_BADGES).toContain(badge);
        }
        for (const slot of body.mealSlots) {
            expect(MEAL_SLOTS).toContain(slot);
        }
        expect(body.badges.length).toBeGreaterThan(0);
        expect(body.mealSlots.length).toBeGreaterThan(0);
    });

    it('emits machine codes, never the labels the client renders', async () => {
        const version = await seedRichVersion(30);

        const response = await getRecipe(owner, version.id);
        const body = response.body as RecipeVersionResponse;

        expect(body.badges).toEqual(['high_protein', 'gluten_free']);
        // A test that accepted the display string would let the mobile app's
        // copy leak into the API contract.
        expect(body.badges).not.toContain('High protein');
        expect(body.badges).not.toContain('Gluten free');
        expect(body.nutritionProvenance).toBe('source_backed');
        expect(body.allergenStatus).toBe('known');
        expect(body.dietTags).toEqual(['pescatarian']);
        expect(body.allergenTags).toEqual(['milk']);
    });

    it('drops an unrecognised badge or slot instead of putting it on the wire', async () => {
        // The columns are plain TEXT with no enum and no CHECK, so an
        // out-of-set member IS storable and the seed is where it is refused.
        // What must not happen is it reaching a client that declares these
        // fields as closed unions; dropping it states less, which is honest.
        const version = await makeRecipeVersion({
            sequence: 31,
            slug: 'recipes-suite-unknown-codes',
            badges: ['high_protein', 'future_badge'],
            meal_slots: ['breakfast', 'brunch'],
        });

        const response = await getRecipe(owner, version.id);
        const body = response.body as RecipeVersionResponse;

        expect(response.status).toBe(200);
        expect(body.badges).toEqual(['high_protein']);
        expect(body.mealSlots).toEqual(['breakfast']);
    });

    it('leaves the tag taxonomies open, so a new diet or allergen tag still travels', async () => {
        // The inverse decision to the two above, and deliberate: diet and
        // allergen tags are drawn from catalog metadata, so filtering them
        // would understate what a recipe contains — the one direction of error
        // that reaches a plate.
        const version = await makeRecipeVersion({
            sequence: 32,
            slug: 'recipes-suite-open-tags',
            diet_tags: ['vegan', 'low_fodmap'],
            allergen_tags: ['sesame', 'lupin'],
        });

        const response = await getRecipe(owner, version.id);
        const body = response.body as RecipeVersionResponse;

        expect(body.dietTags).toEqual(['vegan', 'low_fodmap']);
        expect(body.allergenTags).toEqual(['sesame', 'lupin']);
    });
});

/* ---------------------------------------------------------------------------
 * A retired version belongs to whoever still points at it
 * ------------------------------------------------------------------------- */

describe('a retired version is caller-scoped', () => {
    it('resolves for the user whose plan currently plans it', async () => {
        const version = await seedRetiredVersion(40);
        await linkPlannedRecipe(owner, version.id);

        const response = await getRecipe(owner, version.id);

        expect(response.status).toBe(200);
        expect((response.body as RecipeVersionResponse).versionId).toBe(version.id);
        expect((response.body as RecipeVersionResponse).status).toBe('retired');
    });

    it('resolves for the user whose plan swapped away from it', async () => {
        // The `previous_recipe_version_id` arm. The meal's current recipe is a
        // different version, so nothing but this reference can grant visibility
        // — a suite that covered only the first arm would pass while the swap
        // history silently 404ed for its rightful owner.
        const swappedAway = await seedRetiredVersion(41);
        const nowPlanned = await seedCurrentVersion(42);
        await linkPreviousRecipe(owner, nowPlanned.id, swappedAway.id);

        const response = await getRecipe(owner, swappedAway.id);

        expect(response.status).toBe(200);
        expect((response.body as RecipeVersionResponse).versionId).toBe(swappedAway.id);
        expect(
            await prisma.meal_plan_meals.count({
                where: { user_id: owner, recipe_version_id: swappedAway.id },
            }),
        ).toBe(0);
    });

    it('resolves for the user whose diary entry points at it, with no plan involved', async () => {
        const version = await seedRetiredVersion(43);
        await linkDiaryEntry(owner, version);

        const response = await getRecipe(owner, version.id);

        expect(response.status).toBe(200);
        expect((response.body as RecipeVersionResponse).versionId).toBe(version.id);
        expect(await prisma.meal_plan_meals.count({ where: { user_id: owner } })).toBe(0);
    });

    it('refuses it when the only diary entry pointing at it has been deleted', async () => {
        // The off-by-one this arm exists for: the predicate is non-deleted
        // entries, and a soft-deleted row is the user having removed the meal —
        // keeping the visibility it granted would outlive the reason for it.
        const version = await seedRetiredVersion(44);
        await linkDiaryEntry(owner, version, { deleted: true });

        const response = await getRecipe(owner, version.id);

        expectNotFound(response.status, response.body);
        expect(
            await prisma.meal_entries.count({
                where: { user_id: owner, recipe_version_id: version.id },
            }),
        ).toBe(1);
    });

    it('refuses it to a caller who references nothing', async () => {
        const version = await seedRetiredVersion(45);

        const response = await getRecipe(owner, version.id);

        expectNotFound(response.status, response.body);
    });

    it('resolves it on a week that has already finished, because history stays readable', async () => {
        // The reference check filters on the owner and the recipe and on
        // nothing about the plan's dates, which is what keeps a months-old plan
        // openable. The fixture week is in the past by construction.
        const version = await seedRetiredVersion(46);
        await linkPlannedRecipe(owner, version.id, REFERENCE_WEEK_START);
        const plan = await prisma.meal_plans.findFirstOrThrow({
            where: { user_id: owner },
            select: { start_date: true, status: true },
        });

        const response = await getRecipe(owner, version.id);

        expect(plan.start_date.toISOString()).toContain(REFERENCE_WEEK_START);
        expect(plan.status).toBe('active');
        expect(response.status).toBe(200);
    });

    it('resolves it for the owner of the plan that references it, and refuses it to everyone else', async () => {
        const version = await seedRetiredVersion(47);
        await linkPlannedRecipe(stranger, version.id);

        const asReferencingUser = await getRecipe(stranger, version.id);
        const asOtherUser = await getRecipe(owner, version.id);

        expect(asReferencingUser.status).toBe(200);
        expectNotFound(asOtherUser.status, asOtherUser.body);
    });

    it('resolves it for the owner of the diary entry that references it, and refuses it to everyone else', async () => {
        const version = await seedRetiredVersion(48);
        await linkDiaryEntry(stranger, version);

        const asReferencingUser = await getRecipe(stranger, version.id);
        const asOtherUser = await getRecipe(owner, version.id);

        expect(asReferencingUser.status).toBe(200);
        expectNotFound(asOtherUser.status, asOtherUser.body);
    });

    it('keeps two callers’ references apart when each holds one of its own', async () => {
        // Both users reference the same retired version through different
        // plans, on non-overlapping weeks. Neither borrows the other's claim:
        // each resolves on its own reference, which is what a predicate missing
        // `user_id` would make indistinguishable from the cases above.
        const version = await seedRetiredVersion(49);
        await linkPlannedRecipe(owner, version.id, REFERENCE_WEEK_START);
        await linkPlannedRecipe(stranger, version.id, SECOND_REFERENCE_WEEK_START);

        const asOwner = await getRecipe(owner, version.id);
        const asStranger = await getRecipe(stranger, version.id);

        expect(asOwner.status).toBe(200);
        expect(asStranger.status).toBe(200);
        expect(asStranger.body).toEqual(asOwner.body);
    });
});

/* ---------------------------------------------------------------------------
 * Existence never leaks
 * ------------------------------------------------------------------------- */

describe('existence never leaks', () => {
    it('answers a version referenced only by someone else exactly as it answers one that does not exist', async () => {
        const foreign = await seedRetiredVersion(50);
        await linkPlannedRecipe(stranger, foreign.id);

        const foreignResponse = await getRecipe(owner, foreign.id);
        const missingResponse = await getRecipe(owner, UNKNOWN_VERSION_ID);

        expect(foreignResponse.status).toBe(missingResponse.status);
        // Whole-body equality, not just the status: any difference between the
        // two — a code, a message, an extra member — is an oracle for what
        // exists in another user's account (Rule 7 §1.5, §8).
        expect(foreignResponse.body).toEqual(missingResponse.body);
        expectNotFound(foreignResponse.status, foreignResponse.body);
    });

    it('answers a version referenced only by another user’s diary the same way', async () => {
        const foreign = await seedRetiredVersion(51);
        await linkDiaryEntry(stranger, foreign);

        const foreignResponse = await getRecipe(owner, foreign.id);
        const missingResponse = await getRecipe(owner, UNKNOWN_VERSION_ID);

        expect(foreignResponse.body).toEqual(missingResponse.body);
        expectNotFound(foreignResponse.status, foreignResponse.body);
    });

    it('answers a stored version nobody references exactly as it answers a missing id', async () => {
        const unreferenced = await seedRetiredVersion(52);

        const storedResponse = await getRecipe(owner, unreferenced.id);
        const missingResponse = await getRecipe(owner, SECOND_UNKNOWN_VERSION_ID);

        expect(storedResponse.body).toEqual(missingResponse.body);
        expect(storedResponse.status).toBe(missingResponse.status);
        // The row is there; only the caller's right to see it is not.
        expect(
            await prisma.recipe_versions.count({ where: { id: unreferenced.id } }),
        ).toBe(1);
    });

    it('never answers 403, whatever the caller is refused', async () => {
        // A 403 would confirm the resource exists, which is the whole reason
        // this route answers 404 for every refusal.
        const foreign = await seedRetiredVersion(53);
        await linkPlannedRecipe(stranger, foreign.id);
        const unreferenced = await seedRetiredVersion(54);

        const statuses = await Promise.all(
            [
                getRecipe(owner, foreign.id),
                getRecipe(owner, unreferenced.id),
                getRecipe(owner, UNKNOWN_VERSION_ID),
                getRecipe(owner, MALFORMED_VERSION_IDS[0]),
                getRecipeUnauthenticated(foreign.id),
            ].map(async (pending) => (await pending).status),
        );

        expect(statuses).toEqual([404, 404, 404, 400, 401]);
        expect(statuses).not.toContain(403);
    });
});

/* ---------------------------------------------------------------------------
 * The request boundary
 * ------------------------------------------------------------------------- */

describe('the request boundary', () => {
    it.each(MALFORMED_VERSION_IDS)('refuses %s with invalid_request naming the path parameter', async (malformed) => {
        const response = await getRecipe(owner, malformed);

        expectInvalidId(response.status, response.body);
    });

    it('accepts a well-formed id in upper case and answers 404, not 400', async () => {
        // The boundary between the two refusals: the parser's pattern is
        // case-insensitive, so this value COULD denote a version — it simply
        // denotes none. Deciding whether one exists is not the parser's job.
        const response = await getRecipe(owner, UPPERCASE_UNKNOWN_VERSION_ID);

        expectNotFound(response.status, response.body);
    });

    it('refuses a request carrying no identity, before the handler runs', async () => {
        // The router mounts after `app.use(authenticateFirebaseToken)`, so this
        // 401 is the mount-order boundary Rule 7 §3.1 describes. Seeding a
        // resolvable version first means the refusal cannot be mistaken for a
        // missing one.
        const version = await seedCurrentVersion(60);

        const response = await getRecipeUnauthenticated(version.id);

        expect(response.status).toBe(401);
        expectSafeErrorBody(response.body, ['error']);
        expect(await getRecipe(owner, version.id)).toMatchObject({ status: 200 });
    });
});

/* ---------------------------------------------------------------------------
 * What this response deliberately does not carry
 * ------------------------------------------------------------------------- */

describe('the response carries no planned-meal context', () => {
    /**
     * Every member that belongs to a PLANNED meal rather than to a recipe.
     * §0.5.2 puts all of them on `GET …/plans/:planId/days/:date`, composed on
     * the client, so asserting their absence is what keeps a shared read from
     * quietly becoming a user-scoped one. It is cheap now and impossible to
     * reconstruct once a consumer depends on it.
     */
    const PLANNED_MEAL_MEMBERS: readonly string[] = [
        'portionMultiplier',
        'portionText',
        'planned',
        'plannedCalories',
        'plannedTotals',
        'slot',
        'slotTime',
        'sortOrder',
        'logged',
        'loggedEntries',
        'loggedAt',
        'planId',
        'planRevision',
        'planStatus',
        'previousRecipe',
        'flags',
        'mealId',
        'isLastDay',
        'dayIndex',
    ];

    it('omits the portion, the planned nutrition, the slot, the logged state and the plan revision', async () => {
        const version = await seedRichVersion(70);
        await linkPlannedRecipe(owner, version.id);

        const response = await getRecipe(owner, version.id);
        const keys = collectKeysDeep(response.body);

        expect(response.status).toBe(200);
        for (const member of PLANNED_MEAL_MEMBERS) {
            expect([...keys]).not.toContain(member);
        }
    });

    it('names no user and leaks no column name', async () => {
        const version = await seedRichVersion(70);

        const response = await getRecipe(owner, version.id);
        const keys = [...collectKeysDeep(response.body)];

        expect(keys).not.toContain('userId');
        expect(keys).not.toContain('user_id');
        // The database is snake_case and the wire is camelCase (Rule 7 §1.4,
        // §6); one underscore anywhere means a row reached the client unmapped.
        expect(keys.filter((key) => key.includes('_'))).toEqual([]);
        expect(JSON.stringify(response.body)).not.toContain(owner);
    });
});

/* ---------------------------------------------------------------------------
 * A stored row that contradicts the contract
 * ------------------------------------------------------------------------- */

describe('a row that contradicts the response contract', () => {
    /**
     * These rows are only reachable because the code columns are plain TEXT with
     * no enum and no CHECK — deliberately, so `recipe.logic.ts` and the seed are
     * the single enforcement point. The mapper's refusal is therefore the last
     * line, and it surfaces as a 500 rather than a 404 on purpose: the resource
     * exists and the caller may see it, and what failed is the data behind it.
     * The quiet alternatives would be a recipe presented as free of allergens
     * or as having no steps to follow.
     *
     * The log is silenced so a deliberate failure does not read as a broken run,
     * and restored immediately — `clearMocks` does not restore a spy.
     */
    const withSilencedErrorLog = async (assertions: () => Promise<void>): Promise<void> => {
        const errorLog = jest.spyOn(console, 'error').mockImplementation(() => undefined);

        try {
            await assertions();
            expect(errorLog).toHaveBeenCalled();
        } finally {
            errorLog.mockRestore();
        }
    };

    it('fails safely when a code column holds a value outside its closed set', async () => {
        const version = await makeRecipeVersion({
            sequence: 80,
            slug: 'recipes-suite-unsupported-icon',
            icon_key: 'not_a_glyph',
        });

        await withSilencedErrorLog(async () => {
            const response = await getRecipe(owner, version.id);

            expect(response.status).toBe(500);
            // The mapper's own message names the offending column and row,
            // which belongs in the log and nowhere near a client.
            expectSafeErrorBody(response.body, ['error']);
            expect(response.body).toEqual({ error: 'Failed to get recipe' });
        });
    });

    it('fails safely rather than serving a recipe with no steps', async () => {
        const version = await makeRecipeVersion({
            sequence: 81,
            slug: 'recipes-suite-no-instructions',
            instructions: [],
        });

        await withSilencedErrorLog(async () => {
            const response = await getRecipe(owner, version.id);

            expect(response.status).toBe(500);
            expectSafeErrorBody(response.body, ['error']);
        });
    });
});

/* ---------------------------------------------------------------------------
 * The flag gate
 * ------------------------------------------------------------------------- */

describe('the meal-planning flag gate', () => {
    const FEATURE_DISABLED_BODY = { error: 'feature_disabled' };

    beforeEach(() => {
        // Runs after the top-level hook, which restored the gate to on.
        mealPlanningEnabled.mockReturnValue(false);
    });

    it('answers 503 feature_disabled for a version that would otherwise resolve', async () => {
        // Seeded and proved resolvable with the gate on, so the 503 is provably
        // the gate and not a missing fixture.
        mealPlanningEnabled.mockReturnValue(true);
        const version = await seedCurrentVersion(90);
        expect((await getRecipe(owner, version.id)).status).toBe(200);
        mealPlanningEnabled.mockReturnValue(false);

        const response = await getRecipe(owner, version.id);

        expect(response.status).toBe(503);
        expect(response.body).toEqual(FEATURE_DISABLED_BODY);
        expectSafeErrorBody(response.body, ['error']);
    });

    it('answers identically for a resolvable, a referenced-retired, a missing and a malformed id', async () => {
        // The gate has to run BEFORE the lookup and before the parser. If it
        // ran after either, the refusal would still distinguish what exists
        // while the feature is off.
        mealPlanningEnabled.mockReturnValue(true);
        const current = await seedCurrentVersion(91);
        const retired = await seedRetiredVersion(92);
        await linkPlannedRecipe(owner, retired.id);
        mealPlanningEnabled.mockReturnValue(false);

        const responses = await Promise.all([
            getRecipe(owner, current.id),
            getRecipe(owner, retired.id),
            getRecipe(owner, UNKNOWN_VERSION_ID),
            getRecipe(owner, MALFORMED_VERSION_IDS[0]),
        ]);

        for (const response of responses) {
            expect(response.status).toBe(503);
            expect(response.body).toEqual(FEATURE_DISABLED_BODY);
        }
    });

    it('still refuses an unauthenticated request with 401, because auth comes first', async () => {
        const response = await getRecipeUnauthenticated(UNKNOWN_VERSION_ID);

        expect(response.status).toBe(401);
    });

    it('leaves the catalog reads alone, which do not depend on meal planning', async () => {
        // One contrast case; the depth belongs to `api/catalog.test.ts`. The
        // response is data-bearing, so it also shows the read reached the
        // database rather than short-circuiting.
        mealPlanningEnabled.mockReturnValue(true);
        await seedCurrentVersion(93);
        mealPlanningEnabled.mockReturnValue(false);

        const response = await asUser(request.get('/api/catalog/status'), { uid: owner });

        expect(response.status).toBe(200);
        expect(response.body).toMatchObject({ recipeCount: 1 });
    });
});
