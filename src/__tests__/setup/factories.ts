/**
 * Row builders for the suites (Agent Action Plan §0.7.1 Group 1).
 *
 * Every function here is a PURE builder: no I/O, no Prisma call, no clock and
 * no randomness. A suite composes one and hands it to Prisma itself —
 * `prisma.catalog_foods.create({ data: makeCatalogFood({ source_key: 'usda:1' }) })`
 * — so the factory never owns a connection and a test that needs three foods
 * spells out exactly how the three differ.
 *
 * Determinism is the point, and it has one consequence worth stating: the
 * defaults are a single row, not a row generator. Unique columns
 * (`users.email`, `catalog_foods.source_key`, `catalog_foods.usda_fdc_id`,
 * `recipes.slug`, `(recipe_id, version)`, `(user_id, generation_key)`) must be
 * overridden when a suite creates more than one row of a kind; a random suffix
 * would hide an ordering bug behind a passing test one run in ten.
 *
 * Defaults satisfy the closed vocabularies the schema comments state — a food
 * is `published`, `source_backed`, `known`-allergen and `verified`, and a
 * recipe version is `current` and `source_backed` — because those are the only
 * values planning admits (§0.7.3). A suite exercising a rejection path states
 * the deviant value in its overrides, where the reader can see it.
 *
 * The types come from the generated client through a TYPE-ONLY import, which
 * TypeScript erases: this module adds nothing to the runtime module graph and
 * therefore cannot pull a Prisma client into a process the database guard has
 * not cleared.
 */

import type { Prisma } from '../../generated/prisma';

/**
 * Fixed identifiers, so a failing assertion names a row the reader can find.
 * Version-4-shaped uuids, because the columns they stand in for are `@db.Uuid`
 * and PostgreSQL validates the form.
 */
export const FIXTURE_USER_ID = 'test-user-0000000001';
export const FIXTURE_CATALOG_FOOD_ID = '11111111-1111-4111-8111-111111111111';
export const FIXTURE_RECIPE_ID = '22222222-2222-4222-8222-222222222222';
export const FIXTURE_RECIPE_VERSION_ID = '33333333-3333-4333-8333-333333333333';
export const FIXTURE_MEAL_PLAN_ID = '44444444-4444-4444-8444-444444444444';

/**
 * The fixed week every plan fixture covers (a Monday to the following Sunday),
 * expressed at UTC midnight because both columns are `@db.Date`.
 */
export const FIXTURE_PLAN_START_DATE = new Date('2026-01-05T00:00:00.000Z');
export const FIXTURE_PLAN_END_DATE = new Date('2026-01-11T00:00:00.000Z');

/**
 * A user. `id` has no database default — it is the Firebase uid — so it is
 * always supplied, and it is the value `asUser`'s `x-test-user-id` header
 * should carry for a request that must find this user's rows.
 */
export const makeUser = (
    overrides: Partial<Prisma.usersUncheckedCreateInput> = {},
): Prisma.usersUncheckedCreateInput => ({
    id: FIXTURE_USER_ID,
    email: 'fixture.user@example.test',
    first_name: 'Fixture',
    last_name: 'User',
    // A full target profile: the partial and all-null profiles are real cases
    // (`users.target_*` are nullable and mean "not set"), so a suite that wants
    // one says so rather than inheriting it.
    target_calories: 2100,
    target_protein_g: 160,
    target_carbs_g: 210,
    target_fat_g: 70,
    ...overrides,
});

/**
 * A published, source-backed catalog food — the only kind planning may use.
 *
 * `nutrition_basis: 'per_100g'` with `basis_amount: 100` is the pairing the
 * nutrient columns are stated against; a `per_serving` food must override both
 * together, which is why they sit next to each other here.
 */
export const makeCatalogFood = (
    overrides: Partial<Prisma.catalog_foodsUncheckedCreateInput> = {},
): Prisma.catalog_foodsUncheckedCreateInput => ({
    id: FIXTURE_CATALOG_FOOD_ID,
    source_key: 'usda:170379',
    canonical_name: 'broccoli, raw',
    display_name: 'Broccoli, raw',
    category: 'produce_vegetable',
    food_state: 'raw',
    identity_source: 'usda',
    identity_status: 'verified',
    nutrition_provenance: 'source_backed',
    nutrition_version: 1,
    metadata_version: 1,
    nutrition_basis: 'per_100g',
    basis_amount: 100,
    calories: 34,
    protein_g: 2.8,
    carbs_g: 6.6,
    fat_g: 0.4,
    fiber_g: 2.6,
    density_g_per_ml: null,
    usda_fdc_id: 170379,
    usda_data_type: 'sr_legacy_food',
    usda_description: 'Broccoli, raw',
    publication_status: 'published',
    allergen_tags: [],
    allergen_status: 'known',
    diet_tags: ['vegan', 'vegetarian', 'pescatarian'],
    food_group: 'broccoli',
    is_common_dislike: false,
    cost_class: 1,
    search_text: 'broccoli raw',
    ...overrides,
});

/**
 * A current recipe version. `recipe_id` defaults to `FIXTURE_RECIPE_ID`, so a
 * suite creates the `recipes` row with that id first (or overrides this field
 * with the id it created) — the FK is `onDelete: Cascade` and not deferrable.
 *
 * `meal_slots` is given a real slot because the column has no default by
 * design: a version with no slot is never plannable, and an empty list must
 * fail the insert rather than be stored (see the schema comment).
 */
export const makeRecipeVersion = (
    overrides: Partial<Prisma.recipe_versionsUncheckedCreateInput> = {},
): Prisma.recipe_versionsUncheckedCreateInput => ({
    id: FIXTURE_RECIPE_VERSION_ID,
    recipe_id: FIXTURE_RECIPE_ID,
    version: 1,
    name: 'Roasted Broccoli Bowl',
    description: 'A fixture recipe used by the test suites.',
    icon_key: 'bowl',
    instructions: [
        { step: 1, text: 'Heat the oven to 220C.' },
        { step: 2, text: 'Roast the broccoli for 18 minutes.' },
    ],
    yield_servings: 2,
    serving_description: '1 bowl',
    prep_minutes: 10,
    cook_minutes: 18,
    // Always prep + cook: this is the value a user's cooking-time limit is
    // applied to, so a fixture whose total disagrees with its parts would make
    // an eligibility test meaningless.
    total_minutes: 28,
    meal_slots: ['dinner'],
    diet_tags: ['vegan', 'vegetarian', 'pescatarian'],
    allergen_tags: [],
    allergen_status: 'known',
    budget_tier: 2,
    badges: ['quick'],
    nutrition_provenance: 'source_backed',
    per_serving_calories: 420,
    per_serving_protein_g: 22,
    per_serving_carbs_g: 48,
    per_serving_fat_g: 16,
    status: 'current',
    published_at: FIXTURE_PLAN_START_DATE,
    ...overrides,
});

/**
 * A completed preferences row — the state plan generation requires. Setup-flow
 * suites override `setup_status`/`setup_step` to resume mid-flow.
 *
 * `user_id` is `@unique`: one row per user, so a second user needs its own
 * `user_id` override.
 */
export const makePreferences = (
    overrides: Partial<Prisma.meal_plan_preferencesUncheckedCreateInput> = {},
): Prisma.meal_plan_preferencesUncheckedCreateInput => ({
    user_id: FIXTURE_USER_ID,
    time_zone: 'America/New_York',
    setup_status: 'completed',
    setup_step: null,
    target_route: 'estimated',
    goal: 'maintain',
    goal_weight_kg: 75,
    pace_lb_per_week: 1,
    age: 34,
    height_cm: 178,
    weight_kg: 75,
    weight_source: 'manual',
    sex_for_estimate: 'male',
    height_unit_pref: 'ft_in',
    weight_unit_pref: 'lb',
    activity_level: 'lightly_active',
    diet: 'none',
    allergens: [],
    disliked_food_ids: [],
    disliked_food_groups: [],
    meal_schedule: 'three',
    meal_times: [
        { slot: 'breakfast', time: '08:00' },
        { slot: 'lunch', time: '12:30' },
        { slot: 'dinner', time: '19:00' },
    ],
    cooking_time_limit_min: 30,
    budget_amount: 120,
    budget_currency: 'USD',
    no_budget_preference: false,
    budget_tier: 2,
    target_source: 'estimated',
    targets_revision: 1,
    confirmed_targets: { calories: 2100, protein_g: 160, carbs_g: 210, fat_g: 70 },
    targets_input_revision: 1,
    revision: 1,
    ...overrides,
});

/**
 * An active plan for the fixture week.
 *
 * `targets_snapshot` is what the plan was generated against — a later target
 * change is reported as stale by comparing the two — so it mirrors
 * `makeUser`'s targets, and `generation_key` is the idempotency key that is
 * unique per `(user_id, generation_key)`: a suite publishing a second plan for
 * the same user must override it.
 */
export const makePlan = (
    overrides: Partial<Prisma.meal_plansUncheckedCreateInput> = {},
): Prisma.meal_plansUncheckedCreateInput => ({
    id: FIXTURE_MEAL_PLAN_ID,
    user_id: FIXTURE_USER_ID,
    start_date: FIXTURE_PLAN_START_DATE,
    end_date: FIXTURE_PLAN_END_DATE,
    status: 'active',
    revision: 1,
    generation_attempt: 1,
    preferences_revision: 1,
    targets_revision: 1,
    targets_snapshot: { calories: 2100, protein_g: 160, carbs_g: 210, fat_g: 70 },
    generation_seed: 'fixture-seed-0001',
    generation_key: 'generate:2026-01-05:fixture-seed-0001',
    ...overrides,
});
