/**
 * Fixture builders for the backend test suites (Agent Action Plan §0.7.1
 * Group 1): five factories that INSERT rows and hand back exactly what Prisma
 * returned.
 *
 * They sit on the DATABASE side of the contract boundary (Rule 7 §1.4, §6):
 * they speak snake_case columns and return generated row types. None of them
 * builds a `CatalogFoodResponse`, a `RecipeVersionResponse` or a
 * `MealPlanResponse` — that shaping has exactly one home per shape under
 * `src/services/*.mapper.ts`, and it is what the suites exist to test. Nor does
 * any of them call an application service: a factory writes rows directly, so a
 * suite asserting on `mealPlan.service.ts` never depends on that same service
 * to build its input. Truncation belongs to `testDb.ts` and appears nowhere
 * here, so creating a fixture is never destructive.
 *
 * DETERMINISM. Every factory is a function of its arguments: no random source,
 * and exactly ONE reading of the clock, `utcTodayDayKey()`, which resolves a
 * single default — the week `makePlan` covers when the caller names neither
 * `startDate` nor `today`. That default cannot be a fixed calendar week,
 * because a plan's lifecycle is defined RELATIVE to today: §0.5.1 treats an
 * `active` plan whose `end_date` has passed as ended for every rule, so a
 * pinned week silently becomes an ended plan that `GET /plans/current` omits
 * and every write answers `409 plan_not_active` on. A suite that asserts on
 * dates therefore states them — pass `startDate` for an exact week, or `today`
 * to fix what "now" means and let the current week follow from it, and the
 * fixture is clock-free again. Every other date derives from a day-key
 * parameter with a fixed default, and identities from a monotonic module
 * counter. One consequence the code cannot state itself:
 * `truncateFeatureTables()` empties the database but does NOT reset that
 * counter, so calls made after a truncation keep producing fresh identities. A
 * suite that needs a particular identity — or the same fixture twice over —
 * passes `sequence` and gets byte-identical rows for it; pinning one `sequence`
 * value twice is therefore a deliberate collision on the unique keys involved.
 * The only values not fixed here are the columns whose database default is
 * `now()` (`created_at`, `updated_at`, `meal_plans.published_at`), which are
 * left to the database exactly as production writes them.
 *
 * `catalog_foods.search_vector` is absent from every create below and cannot be
 * added: it is a STORED generated column, so PostgreSQL rejects any write to it
 * and Prisma omits `Unsupported` fields from its create input. `search_text` is
 * the column to set — the database derives the vector from it.
 *
 * Two factories take no owner because their tables have none: `catalog_foods`
 * and `recipes`/`recipe_versions` are the shared, tenant-less tables §0.5.1
 * describes. The two that write rows belonging to a user (`makePreferences`,
 * `makePlan`) take `userId` as their first argument and never default it, so
 * `ownership.test.ts` can stand two owners' fixtures side by side.
 */

import type {
    Prisma,
    catalog_foods,
    meal_plan_preferences,
    recipe_versions,
    users,
} from '../../generated/prisma';
import { prisma } from '../../prisma/client';

/** Reserved by RFC 2606, so no fixture address can belong to anyone. */
const FIXTURE_EMAIL_DOMAIN = 'test.invalid';

/**
 * A week that has permanently ended, for the fixtures that need one: a plan
 * stored `active` whose `end_date` is in the past, which §0.5.1 excludes from
 * current/upcoming resolution and refuses every write against with
 * `409 plan_not_active {reason: 'ended'}`.
 *
 * Fixed rather than derived, and safely so — unlike a current week, an ended
 * one stays ended however long from now the suite runs. Reach it explicitly:
 * `makePlan(userId, { startDate: FIXTURE_ENDED_PLAN_START_DAY_KEY })`.
 * `makePlan`'s own default is the CURRENT week (`currentPlanStartDayKey`), so
 * the two states are asked for by name and neither is reached by accident.
 */
export const FIXTURE_ENDED_PLAN_START_DAY_KEY = '2026-07-05';

/**
 * What `published_at` / `imported_at` carry. Fixed, and nothing about a
 * lifecycle turns on it: a publication date is history, so it is never compared
 * against today the way a plan's week is.
 */
const FIXTURE_PUBLISHED_DAY_KEY = '2026-06-01';

/** A published week is seven days; also `makePlan`'s default day count. */
const DAYS_PER_PLAN = 7;

const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;

/** Every nutrient column is stated per 100 g of the food. */
const BASIS_GRAMS = 100;

/**
 * Synthetic FDC ids, an order of magnitude above the real ones, so a fixture
 * food can never collide with a row a manifest or release load produced.
 */
const FIXTURE_FDC_ID_BASE = 9_000_000;

/** Four macro values that are always present: targets, planned totals, per-serving nutrition. */
export interface FixtureMacros {
    calories: number;
    protein: number;
    carbs: number;
    fat: number;
}

/** The documented shape of `recipe_ingredients.snapshot_per_100g`. */
export interface FixturePer100g {
    calories: number;
    protein_g: number;
    carbs_g: number;
    fat_g: number;
    fiber_g: number;
}

/** One entry of `meal_plan_preferences.meal_times`. */
export interface FixtureMealTime {
    slot: string;
    time: string;
}

/**
 * The confirmed targets a plan-ready fixture is built around, on the 30/30/40
 * split §0.7.3 specifies for 2,100 kcal. The keys are the wire names
 * `targets.logic.ts` compares against (`calories`, `protein`, `carbs`, `fat`) —
 * NOT the column names — because `confirmed_targets` is matched field by field
 * against `TargetsResponse.targets`, and a snapshot spelled `protein_g` would
 * silently resolve the source to `legacy`.
 */
export const FIXTURE_TARGETS: FixtureMacros = {
    calories: 2100,
    protein: 158,
    carbs: 210,
    fat: 70,
};

/**
 * The same four numbers as `users` columns, derived so the two spellings cannot
 * drift. `makePreferences` defaults to a confirmed-estimate state, which is
 * only coherent for a user whose targets agree with it, so a plan-ready fixture
 * pairs `makeUser({ ...FIXTURE_USER_TARGET_COLUMNS })` with `makePreferences`.
 */
export const FIXTURE_USER_TARGET_COLUMNS = {
    target_calories: FIXTURE_TARGETS.calories,
    target_protein_g: FIXTURE_TARGETS.protein,
    target_carbs_g: FIXTURE_TARGETS.carbs,
    target_fat_g: FIXTURE_TARGETS.fat,
};

/** One planned slot of a plan fixture, before its nutrition is scaled. */
export interface FixturePlanSlotOptions {
    slot: string;
    slot_time: string;
    portion_multiplier?: number;
    /** A different recipe for this slot. Omitted, the plan's own recipe is used. */
    recipeVersionId?: string;
}

/**
 * Wire order is `breakfast, lunch, dinner[, snack]` — the snack goes last even
 * though its TIME falls between lunch and dinner, which is exactly the case
 * §0.5.2 allows.
 */
const THREE_MEAL_TIMES: readonly FixtureMealTime[] = [
    { slot: 'breakfast', time: '08:00' },
    { slot: 'lunch', time: '12:30' },
    { slot: 'dinner', time: '18:30' },
];

const THREE_PLUS_SNACK_MEAL_TIMES: readonly FixtureMealTime[] = [
    ...THREE_MEAL_TIMES,
    { slot: 'snack', time: '15:30' },
];

/** Unknown or null schedules resolve to no times, so the caller states them. */
const MEAL_TIMES_BY_SCHEDULE: Record<string, readonly FixtureMealTime[] | undefined> = {
    three: THREE_MEAL_TIMES,
    three_plus_snack: THREE_PLUS_SNACK_MEAL_TIMES,
};

const DEFAULT_MEAL_SCHEDULE = 'three';

/**
 * The slots `makePlan` fills each day, DERIVED from the schedule above so a
 * plan fixture and a preferences fixture cannot come to disagree about which
 * meals a day holds or when they are eaten.
 */
const FIXTURE_PLAN_SLOTS: readonly FixturePlanSlotOptions[] = THREE_MEAL_TIMES.map(
    ({ slot, time }) => ({ slot, slot_time: time }),
);

/**
 * An object typed as an interface is not assignable to `Prisma.InputJsonValue`
 * however JSON-safe its members are — TypeScript infers an implicit index
 * signature for a type alias but not for an interface. Same resolution as
 * `mealPlanningAction.service.ts`, in one place.
 */
const asJsonColumnValue = (value: object): Prisma.InputJsonValue =>
    value as unknown as Prisma.InputJsonValue;

/**
 * Identities are drawn from this counter, never from `uuid()` or `Math.random()`
 * — see the determinism note in the module header for what a truncation does
 * and does not reset.
 */
let sequenceCounter = 0;

const nextSequence = (): number => {
    sequenceCounter += 1;

    return sequenceCounter;
};

const resolveSequence = (sequence: number | undefined): number => sequence ?? nextSequence();

const DAY_KEY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** Characters of an ISO timestamp that make up its `yyyy-MM-dd` day key. */
const DAY_KEY_LENGTH = 10;

/**
 * A `@db.Date` column value. Parsed at UTC midnight so day arithmetic is exact
 * (no zone, so no DST step), and rejected loudly rather than handed to Postgres
 * as an `Invalid Date` that surfaces as an opaque driver error.
 */
const toUtcMidnight = (dayKey: string): Date => {
    if (!DAY_KEY_PATTERN.test(dayKey)) {
        throw new Error(`Fixture day key must be formatted yyyy-MM-dd, received "${dayKey}".`);
    }

    const parsed = new Date(`${dayKey}T00:00:00.000Z`);

    // The round trip is the real check: V8 does not reject an out-of-range day
    // in an ISO string, it rolls it over — "2026-02-30" parses as 2 March — so
    // a fixture would silently sit on a date its caller never wrote.
    if (Number.isNaN(parsed.getTime()) || !parsed.toISOString().startsWith(dayKey)) {
        throw new Error(`Fixture day key "${dayKey}" is not a real calendar date.`);
    }

    return parsed;
};

const addUtcDays = (date: Date, days: number): Date =>
    new Date(date.getTime() + days * MILLISECONDS_PER_DAY);

/** The `yyyy-MM-dd` key of a UTC instant — the inverse of `toUtcMidnight`. */
const toDayKey = (date: Date): string => date.toISOString().slice(0, DAY_KEY_LENGTH);

/**
 * Today in UTC, as a day key. The module's ONE clock read (see the header), and
 * exported so a suite deriving a neighbouring week — an upcoming plan, a plan
 * that ends tomorrow — anchors it to the same "now" the default plan used
 * instead of reading the clock a second time and straddling UTC midnight.
 */
export const utcTodayDayKey = (): string => toDayKey(new Date());

/**
 * Day-key arithmetic, validated: the key goes through `toUtcMidnight`, so a
 * malformed or non-existent date is refused here rather than producing a
 * plausible-looking neighbour. `days` may be negative.
 */
export const addDaysToDayKey = (dayKey: string, days: number): string =>
    toDayKey(addUtcDays(toUtcMidnight(dayKey), days));

/**
 * How far before today a default plan week starts, so that the week contains
 * the OWNER'S today rather than UTC's.
 *
 * The server resolves today in the user's stored IANA zone and never in server
 * time (§0.5.2), and zone offsets run from UTC−12 to UTC+14 — the fixture
 * users `makePreferences` writes sit in `America/New_York`, four or five hours
 * behind. So a user's local day key is always UTC's, one before it, or one
 * after it, and a week beginning the day before UTC today spans
 * `[utcToday − 1, utcToday + 5]`: it contains every one of those three days,
 * whatever zone the fixture's user is in.
 */
const DEFAULT_PLAN_START_DAYS_BEFORE_TODAY = 1;

/**
 * The first day of a plan week that is CURRENT: `GET /plans/current` returns
 * it, and swaps, logs, regenerations and grocery writes are accepted against
 * it. `makePlan`'s default, and the value to build on when a suite wants a
 * neighbouring week — `addDaysToDayKey(currentPlanStartDayKey(), 7)` starts the
 * successor week, which is `upcoming` rather than `current`.
 *
 * Pass `todayDayKey` to fix what "now" means and the result stops depending on
 * the clock. The week returned is current for any `dayCount` of three or more;
 * below that the window is too narrow to hold every zone's today, so a short
 * fixture that cares about lifecycle should name `startDate` outright.
 */
export const currentPlanStartDayKey = (todayDayKey: string = utcTodayDayKey()): string =>
    addDaysToDayKey(todayDayKey, -DEFAULT_PLAN_START_DAYS_BEFORE_TODAY);

export interface MakeUserOptions extends Partial<Prisma.usersUncheckedCreateInput> {
    /** Pins the identity sequence, so an identical call reproduces an identical row. */
    sequence?: number;
}

/**
 * A user. `users.id` has no database default — it is the Firebase uid — so it
 * is always supplied, and it is the value a request's `x-test-user-id` header
 * must carry to be scoped to this user's rows.
 *
 * The four `target_*` columns default to null, which is "never opted in": the
 * state that exercises the local-fallback branches. A partially set state (one
 * column, since the four are independently nullable) and a complete one are the
 * other two cases `TargetsResponse` distinguishes; a suite states the one it
 * wants, spreading `FIXTURE_USER_TARGET_COLUMNS` for a complete state that
 * agrees with `makePreferences`.
 */
export const makeUser = async (options: MakeUserOptions = {}): Promise<users> => {
    const { sequence, ...overrides } = options;
    const ordinal = resolveSequence(sequence);

    return prisma.users.create({
        data: {
            id: `test-user-${ordinal}`,
            email: `user${ordinal}@${FIXTURE_EMAIL_DOMAIN}`,
            first_name: 'Fixture',
            last_name: `User ${ordinal}`,
            target_calories: null,
            target_protein_g: null,
            target_carbs_g: null,
            target_fat_g: null,
            ...overrides,
        },
    });
};

/** The single default portion `makeCatalogFood` gives every food it creates. */
export interface FixturePortionOptions {
    description?: string;
    amount?: number;
    unit?: string;
    gram_weight?: number;
    source?: string;
}

export interface MakeCatalogFoodOptions
    extends Omit<Partial<Prisma.catalog_foodsUncheckedCreateInput>, 'catalog_food_portions'> {
    sequence?: number;
    defaultPortion?: FixturePortionOptions;
}

/**
 * A published, source-backed, allergen-known food — the only kind planning
 * admits (§0.7.3), so it is what the default path produces. A suite exercising
 * a rejection or ineligibility path overrides the one column that matters
 * (`publication_status`, `nutrition_provenance`, `allergen_status`,
 * `allergen_tags`, `diet_tags`), where the reader can see the deviation.
 *
 * Three identity columns move with the sequence rather than one, because three
 * constraints apply to a published food: `source_key` is unique, `usda_fdc_id`
 * is unique, and `(canonical_name, food_state)` is unique among published rows.
 * Varying only `source_key` would make a second default call fail.
 *
 * Exactly one `catalog_food_portions` row is created with it, as a nested write
 * in the same statement so a food without its portion is never observable.
 * Every published food has a default portion — validation quarantines a
 * candidate that lacks one — and `CatalogFoodResponse.defaultPortion` is
 * non-null on that basis, so a food fixture without one would fail the catalog
 * and logging suites for the wrong reason.
 */
export const makeCatalogFood = async (
    options: MakeCatalogFoodOptions = {},
): Promise<catalog_foods> => {
    const { sequence, defaultPortion, ...overrides } = options;
    const ordinal = resolveSequence(sequence);
    const fdcId = FIXTURE_FDC_ID_BASE + ordinal;
    const displayName = `Fixture Food ${ordinal}`;

    return prisma.catalog_foods.create({
        data: {
            source_key: `usda:${fdcId}`,
            canonical_name: `fixture food ${ordinal}`,
            display_name: displayName,
            category: 'protein_plant',
            food_state: 'cooked',
            identity_source: 'usda',
            identity_status: 'verified',
            nutrition_provenance: 'source_backed',
            nutrition_version: 1,
            metadata_version: 1,
            nutrition_basis: 'per_100g',
            basis_amount: BASIS_GRAMS,
            calories: 150,
            protein_g: 15,
            carbs_g: 20,
            fat_g: 2,
            fiber_g: 3,
            density_g_per_ml: null,
            usda_fdc_id: fdcId,
            usda_data_type: 'sr_legacy_food',
            usda_description: displayName,
            publication_status: 'published',
            allergen_tags: [],
            allergen_status: 'known',
            diet_tags: ['vegan', 'vegetarian', 'pescatarian'],
            food_group: 'fixture_food',
            is_common_dislike: false,
            cost_class: 1,
            search_text: `fixture food ${ordinal}`,
            imported_at: toUtcMidnight(FIXTURE_PUBLISHED_DAY_KEY),
            ...overrides,
            catalog_food_portions: {
                create: {
                    description: defaultPortion?.description ?? '1 cup',
                    amount: defaultPortion?.amount ?? 1,
                    unit: defaultPortion?.unit ?? 'cup',
                    gram_weight: defaultPortion?.gram_weight ?? 200,
                    source: defaultPortion?.source ?? 'usda_food_portion',
                    is_default: true,
                },
            },
        },
    });
};

/**
 * One ingredient of a recipe fixture. `catalogFoodId` names an existing food;
 * omitted, the ingredient uses the recipe's own food. Everything the snapshot
 * columns hold defaults from that food's row, which is what production does at
 * publication time.
 */
export interface FixtureIngredientOptions {
    catalogFoodId?: string;
    per100g?: FixturePer100g;
    quantity?: number;
    unit?: string;
    gram_weight?: number;
    display_text?: string;
    snapshot_name?: string;
    snapshot_provenance?: string;
    snapshot_allergen_tags?: string[];
    snapshot_diet_tags?: string[];
    is_optional?: boolean;
}

export interface MakeRecipeVersionOptions
    extends Omit<
        Partial<Prisma.recipe_versionsUncheckedCreateInput>,
        | 'recipe_id'
        | 'total_minutes'
        | 'per_serving_calories'
        | 'per_serving_protein_g'
        | 'per_serving_carbs_g'
        | 'per_serving_fat_g'
        | 'recipe_ingredients'
        | 'current_of_recipes'
    > {
    sequence?: number;
    /** An existing recipe, for a second version of it. Omitted, a new `recipes` row is created. */
    recipeId?: string;
    /** Only used when a new `recipes` row is created. */
    slug?: string;
    /** The food the default ingredient is built from. Omitted, one is created. */
    catalogFoodId?: string;
    ingredients?: readonly FixtureIngredientOptions[];
    /**
     * Per-serving nutrition to hit exactly — for a suite that needs a recipe of
     * a given calorie size without composing the ingredients that add up to it.
     * Mutually exclusive with `ingredients`; see `makeRecipeVersion`.
     */
    perServing?: FixtureMacros;
}

/** What `makeRecipeVersion` returns: the version with the ingredient rows it created. */
export type FixtureRecipeVersion = Prisma.recipe_versionsGetPayload<{
    include: { recipe_ingredients: true };
}>;

interface ResolvedFixtureIngredient {
    food: catalog_foods;
    per100g: FixturePer100g;
    gramWeight: number;
    allergenTags: string[];
    dietTags: string[];
    data: Prisma.recipe_ingredientsUncheckedCreateWithoutRecipe_versionsInput;
}

const DEFAULT_YIELD_SERVINGS = 2;
const DEFAULT_PREP_MINUTES = 10;
const DEFAULT_COOK_MINUTES = 15;

/**
 * 400 g is two of the default food's 200 g cups, which is why the default
 * ingredient's quantity, unit and display text read as they do. A suite that
 * supplies its own food should supply these too.
 */
const DEFAULT_INGREDIENT_GRAM_WEIGHT = 400;
const DEFAULT_INGREDIENT_QUANTITY = 2;
const DEFAULT_INGREDIENT_UNIT = 'cup';
const DEFAULT_INGREDIENT_DISPLAY_TEXT = '2 cups';

const CURRENT_RECIPE_STATUS = 'current';
const RETIRED_RECIPE_STATUS = 'retired';

/**
 * The snapshot a version freezes for one ingredient. A macro the catalog
 * records as unknown is refused rather than coerced to zero: a snapshot of 0
 * kcal is not "unknown", and a recipe derived from one would report nutrition
 * that is simply wrong. Fibre is genuinely optional in the contract, so an
 * unknown fibre value becomes 0.
 */
const toSnapshotPer100g = (food: catalog_foods): FixturePer100g => {
    const { calories, protein_g, carbs_g, fat_g } = food;

    if (calories === null || protein_g === null || carbs_g === null || fat_g === null) {
        throw new Error(
            `Catalog food "${food.source_key}" records an unknown macro value, so it cannot back a ` +
                'recipe ingredient snapshot. Give the food explicit calories, protein_g, carbs_g and fat_g.',
        );
    }

    return { calories, protein_g, carbs_g, fat_g, fiber_g: food.fiber_g ?? 0 };
};

/**
 * Recipe nutrition exactly as §0.7.3 defines it:
 * Σ(gram_weight × per-100 g value ÷ 100) ÷ yield_servings, read from the frozen
 * snapshots and never from the live catalog row. Derived rather than defaulted
 * so a fixture's stored per-serving figures can never disagree with its own
 * ingredient rows — a fixture that disagreed would let a nutrition-derivation
 * assertion pass against the wrong number.
 */
const derivePerServing = (
    ingredients: readonly ResolvedFixtureIngredient[],
    yieldServings: number,
): FixtureMacros => {
    if (!Number.isFinite(yieldServings) || yieldServings <= 0) {
        throw new Error(
            `Fixture recipe yield_servings must be a positive number, received ${yieldServings}.`,
        );
    }

    const totals = ingredients.reduce(
        (accumulated, { per100g, gramWeight }) => ({
            calories: accumulated.calories + (gramWeight * per100g.calories) / BASIS_GRAMS,
            protein: accumulated.protein + (gramWeight * per100g.protein_g) / BASIS_GRAMS,
            carbs: accumulated.carbs + (gramWeight * per100g.carbs_g) / BASIS_GRAMS,
            fat: accumulated.fat + (gramWeight * per100g.fat_g) / BASIS_GRAMS,
        }),
        { calories: 0, protein: 0, carbs: 0, fat: 0 },
    );

    return {
        calories: totals.calories / yieldServings,
        protein: totals.protein / yieldServings,
        carbs: totals.carbs / yieldServings,
        fat: totals.fat / yieldServings,
    };
};

/** Allergens are the union of the ingredients': one milk ingredient makes the recipe contain milk. */
const deriveAllergenTags = (ingredients: readonly ResolvedFixtureIngredient[]): string[] => [
    ...new Set(ingredients.flatMap(({ allergenTags }) => allergenTags)),
];

/** Diets are the intersection: a recipe is vegan only if every ingredient is. */
const deriveDietTags = (ingredients: readonly ResolvedFixtureIngredient[]): string[] => {
    const [first, ...rest] = ingredients.map(({ dietTags }) => dietTags);

    if (first === undefined) {
        return [];
    }

    return first.filter((tag) => rest.every((tags) => tags.includes(tag)));
};

/** Unknown allergen metadata on any ingredient makes the whole version unknown, and unplannable. */
const deriveAllergenStatus = (ingredients: readonly ResolvedFixtureIngredient[]): string =>
    ingredients.every(({ food }) => food.allergen_status === 'known') ? 'known' : 'unknown';

const findCatalogFoodOrThrow = async (catalogFoodId: string): Promise<catalog_foods> => {
    const existing = await prisma.catalog_foods.findUnique({ where: { id: catalogFoodId } });

    if (existing === null) {
        throw new Error(
            `Fixture references catalog food "${catalogFoodId}", which does not exist. Create it with ` +
                'makeCatalogFood() first, or let the factory create one by omitting the id.',
        );
    }

    return existing;
};

/**
 * One ingredient whose per-100 g snapshot IS the wanted per-serving nutrition,
 * at 100 g × yield_servings. That makes
 * Σ(gram_weight × per-100 g ÷ 100) ÷ yield_servings collapse to the requested
 * figures exactly, so `perServing` never costs the fixture its consistency.
 */
const perServingIngredient = (
    perServing: FixtureMacros,
    yieldServings: number,
): FixtureIngredientOptions => {
    const gramWeight = BASIS_GRAMS * yieldServings;

    return {
        per100g: {
            calories: perServing.calories,
            protein_g: perServing.protein,
            carbs_g: perServing.carbs,
            fat_g: perServing.fat,
            fiber_g: 0,
        },
        gram_weight: gramWeight,
        quantity: gramWeight,
        unit: 'g',
        display_text: `${gramWeight} g`,
    };
};

const resolveIngredient = async (
    option: FixtureIngredientOptions,
    baseFood: catalog_foods,
    sortOrder: number,
): Promise<ResolvedFixtureIngredient> => {
    const food =
        option.catalogFoodId === undefined
            ? baseFood
            : await findCatalogFoodOrThrow(option.catalogFoodId);
    const per100g = option.per100g ?? toSnapshotPer100g(food);
    const gramWeight = option.gram_weight ?? DEFAULT_INGREDIENT_GRAM_WEIGHT;

    if (!Number.isFinite(gramWeight) || gramWeight <= 0) {
        throw new Error(
            `Fixture ingredient gram_weight must be greater than 0, received ${gramWeight}.`,
        );
    }

    const allergenTags = option.snapshot_allergen_tags ?? food.allergen_tags;
    const dietTags = option.snapshot_diet_tags ?? food.diet_tags;

    return {
        food,
        per100g,
        gramWeight,
        allergenTags,
        dietTags,
        data: {
            catalog_food_id: food.id,
            catalog_nutrition_version: food.nutrition_version,
            catalog_metadata_version: food.metadata_version,
            snapshot_per_100g: asJsonColumnValue(per100g),
            snapshot_name: option.snapshot_name ?? food.display_name,
            snapshot_provenance: option.snapshot_provenance ?? food.nutrition_provenance,
            snapshot_allergen_tags: allergenTags,
            snapshot_diet_tags: dietTags,
            quantity: option.quantity ?? DEFAULT_INGREDIENT_QUANTITY,
            unit: option.unit ?? DEFAULT_INGREDIENT_UNIT,
            gram_weight: gramWeight,
            display_text: option.display_text ?? DEFAULT_INGREDIENT_DISPLAY_TEXT,
            sort_order: sortOrder,
            is_optional: option.is_optional ?? false,
        },
    };
};

/**
 * A recipe and its current version, with the ingredient rows that justify its
 * nutrition.
 *
 * The `recipes` row, the `recipe_versions` row, its ingredients and the
 * `recipes.current_version_id` pointer are written in ONE transaction, so a
 * partially built recipe — a version with no ingredients, or a recipe whose
 * current pointer is still null — is never observable.
 *
 * Four values are DERIVED and therefore not overridable: `total_minutes`
 * (prep + cook, the figure a cooking-time limit is applied to) and the four
 * `per_serving_*` columns. `allergen_tags`, `diet_tags` and `allergen_status`
 * are derived from the ingredients too but stay overridable, so an eligibility
 * suite can state `allergen_tags: ['milk']` directly instead of composing a
 * milk-bearing ingredient.
 *
 * `status: 'retired'` produces a retired version and leaves the recipe's
 * current pointer alone — the state the recipe-visibility and ownership suites
 * need, where a retired version stays readable for the plans that reference it.
 */
export const makeRecipeVersion = async (
    options: MakeRecipeVersionOptions = {},
): Promise<FixtureRecipeVersion> => {
    const { sequence, recipeId, slug, catalogFoodId, ingredients, perServing, ...overrides } =
        options;

    if (ingredients !== undefined && perServing !== undefined) {
        throw new Error(
            'Pass either ingredients or perServing to makeRecipeVersion, not both: perServing exists ' +
                'to synthesise the single ingredient that adds up to it.',
        );
    }

    const ordinal = resolveSequence(sequence);
    const yieldServings = overrides.yield_servings ?? DEFAULT_YIELD_SERVINGS;
    const prepMinutes = overrides.prep_minutes ?? DEFAULT_PREP_MINUTES;
    const cookMinutes = overrides.cook_minutes ?? DEFAULT_COOK_MINUTES;
    const status = overrides.status ?? CURRENT_RECIPE_STATUS;
    const publishedAt = toUtcMidnight(FIXTURE_PUBLISHED_DAY_KEY);

    const baseFood =
        catalogFoodId === undefined
            ? await makeCatalogFood({ sequence: ordinal })
            : await findCatalogFoodOrThrow(catalogFoodId);

    const ingredientOptions =
        ingredients ??
        (perServing === undefined ? [{}] : [perServingIngredient(perServing, yieldServings)]);

    if (ingredientOptions.length === 0) {
        throw new Error(
            'A recipe fixture needs at least one ingredient: its nutrition is derived from them.',
        );
    }

    const resolved: ResolvedFixtureIngredient[] = [];

    for (const [index, option] of ingredientOptions.entries()) {
        resolved.push(await resolveIngredient(option, baseFood, index));
    }

    const nutrition = derivePerServing(resolved, yieldServings);

    return prisma.$transaction(async (tx) => {
        if (recipeId !== undefined) {
            const parent = await tx.recipes.findUnique({ where: { id: recipeId } });

            if (parent === null) {
                throw new Error(
                    `Fixture recipe version references recipe "${recipeId}", which does not exist.`,
                );
            }
        }

        const resolvedRecipeId =
            recipeId ??
            (await tx.recipes.create({ data: { slug: slug ?? `fixture-recipe-${ordinal}` } })).id;

        const version = await tx.recipe_versions.create({
            data: {
                recipe_id: resolvedRecipeId,
                version: 1,
                name: `Fixture Recipe ${ordinal}`,
                description: 'A recipe fixture used by the backend test suites.',
                icon_key: 'bowl',
                instructions: [
                    'Warm the pan over a medium heat.',
                    'Combine the ingredients and cook until heated through.',
                ],
                yield_servings: yieldServings,
                serving_description: '1 bowl',
                prep_minutes: prepMinutes,
                cook_minutes: cookMinutes,
                meal_slots: ['breakfast', 'lunch', 'dinner'],
                allergen_tags: deriveAllergenTags(resolved),
                diet_tags: deriveDietTags(resolved),
                allergen_status: deriveAllergenStatus(resolved),
                budget_tier: 1,
                badges: ['high_protein'],
                nutrition_provenance: 'source_backed',
                sourced_calories_note: null,
                published_at: publishedAt,
                retired_at: status === RETIRED_RECIPE_STATUS ? publishedAt : null,
                ...overrides,
                status,
                total_minutes: prepMinutes + cookMinutes,
                per_serving_calories: nutrition.calories,
                per_serving_protein_g: nutrition.protein,
                per_serving_carbs_g: nutrition.carbs,
                per_serving_fat_g: nutrition.fat,
                recipe_ingredients: { create: resolved.map(({ data }) => data) },
            },
            include: { recipe_ingredients: { orderBy: { sort_order: 'asc' } } },
        });

        if (version.status === CURRENT_RECIPE_STATUS) {
            await tx.recipes.update({
                where: { id: resolvedRecipeId },
                data: { current_version_id: version.id },
            });
        }

        return version;
    });
};

export type MakePreferencesOptions = Omit<
    Partial<Prisma.meal_plan_preferencesUncheckedCreateInput>,
    'user_id'
>;

/**
 * The one preferences row a user may have (`user_id` is unique, so a second
 * call for the same user is a conflict, not an update), defaulted to the state
 * `POST /meal-planning/plans` requires: setup complete, every estimate input
 * present, and a confirmed estimate.
 *
 * Body measurements are METRIC, with the display preferences beside them in
 * `height_unit_pref` / `weight_unit_pref` — the service normalises to metric on
 * write, so a fixture holding pounds would not match what the API produces.
 *
 * `meal_times` is derived from `meal_schedule` so the two always agree: flip
 * the schedule to `three_plus_snack` and the snack entry appears. A schedule
 * this factory does not know leaves `meal_times` unset for the caller to state.
 *
 * The four targets columns live on `users`, not here, and
 * `TargetsResponse.source` is only `estimated` while `confirmed_targets`
 * matches them field for field. So the plan-ready pairing is
 * `makeUser({ ...FIXTURE_USER_TARGET_COLUMNS })` with this factory's defaults;
 * overriding `confirmed_targets` (or `target_source`) alone is how a suite
 * reaches the `legacy` verdict, and lowering `targets_input_revision` below
 * `revision` is how it reaches `stale`.
 */
export const makePreferences = async (
    userId: string,
    options: MakePreferencesOptions = {},
): Promise<meal_plan_preferences> => {
    const schedule =
        options.meal_schedule === undefined ? DEFAULT_MEAL_SCHEDULE : options.meal_schedule;
    const mealTimes = schedule === null ? undefined : MEAL_TIMES_BY_SCHEDULE[schedule];

    return prisma.meal_plan_preferences.create({
        data: {
            user_id: userId,
            time_zone: 'America/New_York',
            setup_status: 'completed',
            setup_step: null,
            review_start_date: null,
            target_route: 'estimated',
            goal: 'maintain',
            goal_weight_kg: null,
            pace_lb_per_week: null,
            age: 34,
            height_cm: 178,
            weight_kg: 79,
            weight_source: 'manual',
            sex_for_estimate: 'male',
            height_unit_pref: 'ft_in',
            weight_unit_pref: 'lb',
            activity_level: 'lightly_active',
            diet: 'none',
            allergens: [],
            disliked_food_ids: [],
            disliked_food_groups: [],
            meal_schedule: schedule,
            ...(mealTimes === undefined ? {} : { meal_times: asJsonColumnValue([...mealTimes]) }),
            cooking_time_limit_min: 30,
            budget_amount: null,
            budget_currency: null,
            no_budget_preference: true,
            budget_tier: 3,
            target_source: 'estimated',
            targets_revision: 1,
            confirmed_targets: asJsonColumnValue(FIXTURE_TARGETS),
            targets_input_revision: 1,
            revision: 1,
            ...options,
        },
    });
};

export interface MakePlanOptions
    extends Omit<
        Partial<Prisma.meal_plansUncheckedCreateInput>,
        'user_id' | 'start_date' | 'end_date' | 'meal_plan_days' | 'meal_plan_meals'
    > {
    sequence?: number;
    /**
     * The plan's first day, as `yyyy-MM-dd`, stated absolutely. `end_date`
     * follows from it and `dayCount`. This is how a suite reaches a week that
     * is not the current one — `FIXTURE_ENDED_PLAN_START_DAY_KEY` for an ended
     * plan, `addDaysToDayKey(currentPlanStartDayKey(), 7)` for an upcoming one.
     */
    startDate?: string;
    /**
     * What "today" is, as `yyyy-MM-dd`, when the default current week is wanted
     * without a clock read: the plan then covers the week around this day
     * instead of the week around the real today. Mutually exclusive with
     * `startDate`, which already fixes the week outright.
     */
    today?: string;
    /** Fewer than seven days makes a cheaper fixture; `end_date` shrinks with it. */
    dayCount?: number;
    /** The recipe every slot plans. Omitted, one is created. */
    recipeVersionId?: string;
    /** Pass `[]` for a plan with days and no meals. */
    slots?: readonly FixturePlanSlotOptions[];
}

/** What `makePlan` returns: the plan with its days in date order, each with its meals in slot order. */
export type FixtureMealPlan = Prisma.meal_plansGetPayload<{
    include: { meal_plan_days: { include: { meal_plan_meals: true } } };
}>;

/** The multiplier a planned meal carries unless a slot names another from the allowed set. */
const DEFAULT_PORTION_MULTIPLIER = 1;

const EMPTY_MACROS: FixtureMacros = { calories: 0, protein: 0, carbs: 0, fat: 0 };

const scaleMacros = (macros: FixtureMacros, factor: number): FixtureMacros => ({
    calories: macros.calories * factor,
    protein: macros.protein * factor,
    carbs: macros.carbs * factor,
    fat: macros.fat * factor,
});

const sumMacros = (values: readonly FixtureMacros[]): FixtureMacros =>
    values.reduce(
        (accumulated, macros) => ({
            calories: accumulated.calories + macros.calories,
            protein: accumulated.protein + macros.protein,
            carbs: accumulated.carbs + macros.carbs,
            fat: accumulated.fat + macros.fat,
        }),
        EMPTY_MACROS,
    );

const findRecipeVersionOrThrow = async (recipeVersionId: string): Promise<recipe_versions> => {
    const existing = await prisma.recipe_versions.findUnique({ where: { id: recipeVersionId } });

    if (existing === null) {
        throw new Error(
            `Fixture plan references recipe version "${recipeVersionId}", which does not exist. Create ` +
                'it with makeRecipeVersion() first, or let the factory create one by omitting the id.',
        );
    }

    return existing;
};

const toPerServingMacros = (version: recipe_versions): FixtureMacros => ({
    calories: version.per_serving_calories,
    protein: version.per_serving_protein_g,
    carbs: version.per_serving_carbs_g,
    fat: version.per_serving_fat_g,
});

/**
 * A published week: the plan, its days and every planned meal, written in ONE
 * transaction so no suite can read a half-built plan.
 *
 * Planned nutrition is not invented. Each meal carries its recipe version's
 * per-serving figures scaled by the slot's portion multiplier, and each day
 * carries the sum of its meals, so a totals assertion is measuring the
 * arithmetic rather than a number typed twice.
 *
 * The denormalised owner columns on the days and the meals are taken from the
 * created plan itself, never from the argument, so parent and child cannot
 * disagree. The schema enforces that too — both child tables reference
 * `meal_plans(id, user_id)` as a composite key (§0.5.1) — which is what makes
 * the cross-user 404 matrix meaningful.
 *
 * LIFECYCLE. The default plan is the CURRENT one: it covers the week around
 * today (`currentPlanStartDayKey`), so `GET /plans/current` returns it and a
 * swap, a log, a regeneration or a grocery write is accepted against it. That
 * is the state most suites need, and it is why the default is derived rather
 * than pinned — §0.5.1 reads an `active` plan whose `end_date` has passed as
 * ended, so a fixed week would quietly turn every such fixture into a
 * `409 plan_not_active` the day it went by. The other states are named
 * explicitly: `{ startDate: FIXTURE_ENDED_PLAN_START_DAY_KEY }` for a plan
 * stored `active` that has ended, `{ startDate: addDaysToDayKey(
 * currentPlanStartDayKey(), 7) }` for an upcoming one, `{ status:
 * 'superseded', replaced_plan_id }` for a replaced plan, `{ revision }` for a
 * stale-revision write, `{ dayCount }` for a cheap fixture, and `{ today }` to
 * pin what "now" means without naming the week. `end_date` always follows the
 * start and the day count, so every one of them stays coherent.
 *
 * Two active plans for one user must differ in `startDate`: the partial unique
 * index on `(user_id, start_date) WHERE status = 'active'` rejects the second
 * otherwise, and suites rely on it doing so.
 */
export const makePlan = async (
    userId: string,
    options: MakePlanOptions = {},
): Promise<FixtureMealPlan> => {
    const { sequence, startDate, today, dayCount, recipeVersionId, slots, ...overrides } = options;
    const ordinal = resolveSequence(sequence);
    const plannedDayCount = dayCount ?? DAYS_PER_PLAN;

    if (!Number.isInteger(plannedDayCount) || plannedDayCount < 1) {
        throw new Error(
            `Fixture plan dayCount must be a whole number of at least 1, received ${plannedDayCount}.`,
        );
    }

    // Refused rather than resolved by precedence: `startDate` fixes the week
    // outright and `today` only shapes the default, so a caller passing both
    // means one of the two to take effect and would otherwise never learn
    // which. Naming the conflict costs a line and saves a mystified fixture.
    if (startDate !== undefined && today !== undefined) {
        throw new Error(
            `Fixture plan received both startDate ("${startDate}") and today ("${today}"). startDate ` +
                'already fixes the week, so pass startDate alone for an exact week, or today alone for ' +
                'the current week around that day.',
        );
    }

    const startDayKey = startDate ?? currentPlanStartDayKey(today);
    const start = toUtcMidnight(startDayKey);
    const end = addUtcDays(start, plannedDayCount - 1);
    const slotOptions = slots ?? FIXTURE_PLAN_SLOTS;

    const nutritionByVersion = new Map<string, FixtureMacros>();
    let baseVersionId: string | undefined;

    if (recipeVersionId !== undefined) {
        const named = await findRecipeVersionOrThrow(recipeVersionId);
        baseVersionId = named.id;
        nutritionByVersion.set(named.id, toPerServingMacros(named));
    } else if (slotOptions.some((slotOption) => slotOption.recipeVersionId === undefined)) {
        const created = await makeRecipeVersion({ sequence: ordinal });
        baseVersionId = created.id;
        nutritionByVersion.set(created.id, toPerServingMacros(created));
    }

    for (const slotOption of slotOptions) {
        const slotVersionId = slotOption.recipeVersionId;

        if (slotVersionId !== undefined && !nutritionByVersion.has(slotVersionId)) {
            const named = await findRecipeVersionOrThrow(slotVersionId);
            nutritionByVersion.set(named.id, toPerServingMacros(named));
        }
    }

    const plannedSlots = slotOptions.map((slotOption, index) => {
        const slotVersionId = slotOption.recipeVersionId ?? baseVersionId;

        if (slotVersionId === undefined) {
            throw new Error(`Fixture plan slot "${slotOption.slot}" has no recipe version to plan.`);
        }

        const perServing = nutritionByVersion.get(slotVersionId);

        if (perServing === undefined) {
            throw new Error(
                `Fixture plan slot "${slotOption.slot}" names recipe version "${slotVersionId}", whose ` +
                    'per-serving nutrition was not resolved.',
            );
        }

        const multiplier = slotOption.portion_multiplier ?? DEFAULT_PORTION_MULTIPLIER;

        return {
            slot: slotOption.slot,
            slot_time: slotOption.slot_time,
            sort_order: index,
            recipe_version_id: slotVersionId,
            portion_multiplier: multiplier,
            planned: scaleMacros(perServing, multiplier),
        };
    });

    // Every day plans the same slots, so the day totals are computed once.
    const dayTotals = sumMacros(plannedSlots.map(({ planned }) => planned));

    return prisma.$transaction(async (tx) => {
        const plan = await tx.meal_plans.create({
            data: {
                user_id: userId,
                start_date: start,
                end_date: end,
                status: 'active',
                revision: 1,
                generation_attempt: 1,
                preferences_revision: 1,
                targets_revision: 1,
                targets_snapshot: asJsonColumnValue(FIXTURE_TARGETS),
                generation_seed: `fixture-seed-${ordinal}`,
                generation_key: `generate:${startDayKey}:${ordinal}`,
                replaced_plan_id: null,
                incompatibility_flags: [],
                ...overrides,
            },
        });

        for (let dayIndex = 0; dayIndex < plannedDayCount; dayIndex += 1) {
            const day = await tx.meal_plan_days.create({
                data: {
                    meal_plan_id: plan.id,
                    user_id: plan.user_id,
                    date: addUtcDays(start, dayIndex),
                    day_index: dayIndex,
                    planned_calories: dayTotals.calories,
                    planned_protein_g: dayTotals.protein,
                    planned_carbs_g: dayTotals.carbs,
                    planned_fat_g: dayTotals.fat,
                },
            });

            if (plannedSlots.length > 0) {
                await tx.meal_plan_meals.createMany({
                    data: plannedSlots.map((plannedSlot) => ({
                        meal_plan_day_id: day.id,
                        meal_plan_id: plan.id,
                        user_id: plan.user_id,
                        slot: plannedSlot.slot,
                        slot_time: plannedSlot.slot_time,
                        sort_order: plannedSlot.sort_order,
                        recipe_version_id: plannedSlot.recipe_version_id,
                        portion_multiplier: plannedSlot.portion_multiplier,
                        planned_calories: plannedSlot.planned.calories,
                        planned_protein_g: plannedSlot.planned.protein,
                        planned_carbs_g: plannedSlot.planned.carbs,
                        planned_fat_g: plannedSlot.planned.fat,
                        revision: 1,
                        flags: [],
                    })),
                });
            }
        }

        return tx.meal_plans.findUniqueOrThrow({
            where: { id: plan.id },
            include: {
                meal_plan_days: {
                    orderBy: { day_index: 'asc' },
                    include: { meal_plan_meals: { orderBy: { sort_order: 'asc' } } },
                },
            },
        });
    });
};
