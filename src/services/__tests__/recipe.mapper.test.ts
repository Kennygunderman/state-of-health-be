/**
 * `recipe.mapper.ts` is the row -> DTO boundary for recipe versions, and this
 * suite pins the one thing a reshaping layer can get catastrophically wrong:
 * what it does when a stored row cannot supply a field the contract declares.
 *
 * The rule the file holds, and the reason each case below is a decision
 * somebody could quietly reverse:
 *
 *  - **A MISSING SAFETY LIST IS A FAULT, NOT AN EMPTY LIST.** `allergen_tags`
 *    and `diet_tags` are the derived union of every ingredient's frozen tags
 *    (§0.7.3), and planning eligibility is decided against exactly that union,
 *    so `[]` is the positive claim "contains none of the nine named allergens /
 *    carries no dietary restriction" rather than "unknown". Both columns are
 *    `TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[]`
 *    (`prisma/migrations/20260908000000_meal_planning/migration.sql`), so an
 *    absent value is drift, a projection that dropped the column, or a row
 *    written around the seed — and answering it with a default would publish
 *    that safety claim on behalf of a row that never made it. Whether the data
 *    IS unknown is stated separately, by `allergen_status`.
 *  - **The same holds for the two closed-set code lists.** `meal_slots` is NOT
 *    NULL without a default at all, and `badges` defaults to `[]`; reading an
 *    absent one as "no slots / no badges" understates what the recipe is,
 *    silently, on a row nothing in the sanctioned write path can produce.
 *  - **What DOES degrade, and only this.** An unrecognised MEMBER of
 *    `meal_slots` or `badges` is dropped, never substituted — matching the
 *    mobile converter, so both sides put the same value on the wire, and
 *    leaving a future slot or badge code unable to take a screen down. The two
 *    TAG lists have no such filter because their vocabulary is deliberately
 *    open (`src/types/recipe.ts`), which is why a non-string member of any of
 *    the four throws instead: `filter` would hide it in a code list, and in a
 *    tag list it would reach the client inside a field declared `string[]`.
 *  - **A RECIPE WITH NO STEPS IS LOST DATA, NOT A RECIPE.** `instructions` is
 *    `JSONB NOT NULL` holding what the recipe is cooked from, and frame 12
 *    renders it as the numbered list the user follows. A non-array root and an
 *    empty array are both refused, because either one renders a title, badges,
 *    nutrition and an ingredient list followed by nothing, with no way for the
 *    user or the operator to tell that the steps were lost rather than never
 *    written.
 *  - **Ingredient amounts are the WHOLE RECIPE's, passed through unscaled.**
 *    `quantity`, `gramWeight` and `displayText` are asserted equal to the
 *    stored values, which is the contract the swap preview and recipe detail
 *    both scale from (`quantity x portionMultiplier / yieldServings`). A mapper
 *    that started scaling here would put that rule in a second place and
 *    disagree with the stored per-serving nutrition beside it.
 *  - **The snapshot half fails closed too.** A recipe whose frozen ingredient
 *    safety tags are absent fails the WHOLE recipe rather than presenting an
 *    ingredient that appears to carry no allergens — asserted through
 *    `mapRecipeVersion`, because that is the only way a client ever reaches
 *    `catalog.mapper.ts::mapIngredientSnapshot`.
 *  - **Every legitimate row still maps.** An allergen-free recipe (genuinely
 *    empty tag lists), a retired version and a description-less recipe are
 *    asserted to pass, so "fail closed" cannot be read as "fail on anything
 *    unusual".
 *
 * A dedicated suite for a mapper, where §11 covers mappers by integration,
 * because the behaviour above was ADDED at this checkpoint and the integration
 * suites that would cover it (`src/__tests__/api/recipes.test.ts`,
 * `api/plans.test.ts`, `api/swaps.test.ts`) are §0.7.1 Group 6 deliverables that
 * do not exist yet — leaving a new fail-closed rule with no evidence at all was
 * the worse of the two readings. It changes nothing about the coverage gate:
 * `jest.config.ts` derives its thresholds from `src/services/*.logic.ts` on
 * disk, which a test file cannot join.
 */

import { CatalogMappingError } from '../catalog.mapper';
import {
    mapPlannedRecipeSummary,
    mapRecipeIngredient,
    mapRecipeVersion,
    RecipeIngredientRow,
    RecipeMappingError,
    RecipeVersionRow,
} from '../recipe.mapper';

const VERSION_ID = '7f1d2c34-5678-4abc-9def-0123456789ab';
const CATALOG_FOOD_ID = '11111111-2222-4333-8444-555555555555';

/**
 * Overrides are `unknown`-valued on purpose: every failing case below stores a
 * value the row type forbids, which is exactly the state a `$queryRaw`
 * projection or a row written around the migration can produce and the state
 * the runtime readers exist for. The single cast lives here rather than at
 * thirty call sites.
 */
type RowOverrides = Readonly<Record<string, unknown>>;

const VALID_VERSION: RecipeVersionRow = {
    id: VERSION_ID,
    recipe_id: '22222222-3333-4444-8555-666666666666',
    version: 2,
    name: 'Chicken burrito bowl',
    description: 'A bowl that keeps.',
    icon_key: 'bowl',
    instructions: ['Season the chicken with chili powder, cumin, and salt.', 'Sear 6 to 7 minutes per side.'],
    yield_servings: 2,
    serving_description: '1 bowl',
    prep_minutes: 10,
    cook_minutes: 15,
    total_minutes: 25,
    meal_slots: ['lunch', 'dinner'],
    diet_tags: ['gluten_free'],
    allergen_tags: ['milk'],
    allergen_status: 'known',
    budget_tier: 2,
    badges: ['high_protein'],
    nutrition_provenance: 'source_backed',
    per_serving_calories: 610,
    per_serving_protein_g: 45,
    per_serving_carbs_g: 58,
    per_serving_fat_g: 21,
    status: 'current',
};

const VALID_INGREDIENT: RecipeIngredientRow = {
    catalog_food_id: CATALOG_FOOD_ID,
    catalog_nutrition_version: 3,
    catalog_metadata_version: 4,
    snapshot_per_100g: { calories: 165, protein_g: 31, carbs_g: 0, fat_g: 3.6, fiber_g: null },
    snapshot_name: 'Chicken breast',
    snapshot_provenance: 'source_backed',
    snapshot_allergen_tags: [],
    snapshot_diet_tags: ['gluten_free'],
    quantity: 10,
    unit: 'oz',
    gram_weight: 284,
    display_text: '10 oz',
    is_optional: false,
};

const versionRow = (overrides: RowOverrides = {}): RecipeVersionRow =>
    ({ ...VALID_VERSION, ...overrides }) as unknown as RecipeVersionRow;

const ingredientRow = (overrides: RowOverrides = {}): RecipeIngredientRow =>
    ({ ...VALID_INGREDIENT, ...overrides }) as unknown as RecipeIngredientRow;

/** The values a NOT NULL TEXT[] column can only hold through drift or corruption. */
const ABSENT_OR_NOT_AN_ARRAY: readonly [string, unknown][] = [
    ['null', null],
    ['undefined', undefined],
    ['an object', { breakfast: true }],
    ['a string', 'lunch'],
    ['a number', 3],
    ['a boolean', false],
];

/** The four required TEXT[] columns of `recipe_versions`, and the DTO member each becomes. */
const REQUIRED_LIST_COLUMNS: readonly [string, keyof ReturnType<typeof mapRecipeVersion>][] = [
    ['meal_slots', 'mealSlots'],
    ['badges', 'badges'],
    ['diet_tags', 'dietTags'],
    ['allergen_tags', 'allergenTags'],
];

describe('mapRecipeVersion', () => {
    describe('a required list column that is absent or is not an array', () => {
        REQUIRED_LIST_COLUMNS.forEach(([column]) => {
            ABSENT_OR_NOT_AN_ARRAY.forEach(([label, value]) => {
                it(`fails the response when ${column} is ${label}`, () => {
                    expect(() => mapRecipeVersion(versionRow({ [column]: value }), [VALID_INGREDIENT])).toThrow(
                        RecipeMappingError,
                    );
                });

                it(`names ${column} and the version in the failure when it is ${label}`, () => {
                    expect(() => mapRecipeVersion(versionRow({ [column]: value }), [VALID_INGREDIENT])).toThrow(
                        new RegExp(`recipe_versions\\.${column}[\\s\\S]*${VERSION_ID}`),
                    );
                });
            });
        });

        it('never answers a missing safety list with an empty one', () => {
            // The whole point of the rule: `[]` here would read as "contains no
            // allergens", which is a claim about the food rather than about the
            // data, so there must be no path from an absent column to a mapped
            // response at all.
            expect(() => mapRecipeVersion(versionRow({ allergen_tags: null }), [VALID_INGREDIENT])).toThrow(
                RecipeMappingError,
            );
            expect(() => mapRecipeVersion(versionRow({ diet_tags: undefined }), [VALID_INGREDIENT])).toThrow(
                RecipeMappingError,
            );
        });
    });

    describe('a list member that is not a string', () => {
        REQUIRED_LIST_COLUMNS.forEach(([column]) => {
            it(`fails the response, naming the index, when ${column} carries a number`, () => {
                expect(() => mapRecipeVersion(versionRow({ [column]: ['lunch', 7] }), [VALID_INGREDIENT])).toThrow(
                    new RegExp(`recipe_versions\\.${column}\\[1\\]`),
                );
            });

            it(`fails the response when ${column} carries null`, () => {
                expect(() => mapRecipeVersion(versionRow({ [column]: [null] }), [VALID_INGREDIENT])).toThrow(
                    RecipeMappingError,
                );
            });
        });
    });

    describe('an unrecognised member of a closed-set code list', () => {
        it('drops an unknown meal slot and keeps the known ones', () => {
            const mapped = mapRecipeVersion(versionRow({ meal_slots: ['breakfast', 'brunch', 'dinner'] }), []);

            expect(mapped.mealSlots).toEqual(['breakfast', 'dinner']);
        });

        it('drops an unknown badge and keeps the known ones', () => {
            const mapped = mapRecipeVersion(versionRow({ badges: ['quick', 'sparkly', 'vegan'] }), []);

            expect(mapped.badges).toEqual(['quick', 'vegan']);
        });

        it('keeps an unrecognised diet or allergen tag, because those vocabularies are open', () => {
            const mapped = mapRecipeVersion(
                versionRow({ diet_tags: ['flexitarian'], allergen_tags: ['lupin'] }),
                [],
            );

            expect(mapped.dietTags).toEqual(['flexitarian']);
            expect(mapped.allergenTags).toEqual(['lupin']);
        });
    });

    describe('instructions', () => {
        ABSENT_OR_NOT_AN_ARRAY.forEach(([label, value]) => {
            it(`fails the response when the stored value is ${label}`, () => {
                expect(() => mapRecipeVersion(versionRow({ instructions: value }), [VALID_INGREDIENT])).toThrow(
                    RecipeMappingError,
                );
            });
        });

        it('fails the response when the list is empty', () => {
            expect(() => mapRecipeVersion(versionRow({ instructions: [] }), [VALID_INGREDIENT])).toThrow(
                RecipeMappingError,
            );
        });

        it('names the column and the version so an operator knows which row to repair', () => {
            expect(() => mapRecipeVersion(versionRow({ instructions: [] }), [VALID_INGREDIENT])).toThrow(
                new RegExp(`recipe_versions\\.instructions[\\s\\S]*${VERSION_ID}`),
            );
        });

        it('fails the response when a step is not a string, naming the index', () => {
            expect(() =>
                mapRecipeVersion(versionRow({ instructions: ['Sear the chicken.', 42] }), [VALID_INGREDIENT]),
            ).toThrow(/recipe_versions\.instructions\[1\]/);
        });

        it('emits the stored steps in the stored order', () => {
            const mapped = mapRecipeVersion(versionRow({ instructions: ['First.', 'Second.', 'Third.'] }), []);

            expect(mapped.instructions).toEqual(['First.', 'Second.', 'Third.']);
        });
    });

    describe('a frozen ingredient snapshot whose safety tags are absent', () => {
        it('fails the whole recipe rather than presenting an allergen-free ingredient', () => {
            expect(() =>
                mapRecipeVersion(VALID_VERSION, [ingredientRow({ snapshot_allergen_tags: null })]),
            ).toThrow(CatalogMappingError);
        });

        it('fails the whole recipe when the frozen diet tags are absent', () => {
            expect(() => mapRecipeVersion(VALID_VERSION, [ingredientRow({ snapshot_diet_tags: undefined })])).toThrow(
                CatalogMappingError,
            );
        });

        it('names the column and the catalog food in the failure', () => {
            expect(() =>
                mapRecipeVersion(VALID_VERSION, [ingredientRow({ snapshot_allergen_tags: 'milk' })]),
            ).toThrow(new RegExp(`recipe_ingredients\\.snapshot_allergen_tags[\\s\\S]*${CATALOG_FOOD_ID}`));
        });

        it('fails the whole recipe when a frozen tag is not a string', () => {
            expect(() =>
                mapRecipeVersion(VALID_VERSION, [ingredientRow({ snapshot_allergen_tags: ['milk', 5] })]),
            ).toThrow(/recipe_ingredients\.snapshot_allergen_tags\[1\]/);
        });
    });

    describe('a row that satisfies the contract', () => {
        it('maps every list column through as stored', () => {
            const mapped = mapRecipeVersion(VALID_VERSION, [VALID_INGREDIENT]);

            expect(mapped.mealSlots).toEqual(['lunch', 'dinner']);
            expect(mapped.badges).toEqual(['high_protein']);
            expect(mapped.dietTags).toEqual(['gluten_free']);
            expect(mapped.allergenTags).toEqual(['milk']);
        });

        it('maps a genuinely allergen-free, restriction-free recipe with empty lists', () => {
            // Empty is a legitimate stored value and must still map: "fail
            // closed" is about an ABSENT column, not about an empty one.
            const mapped = mapRecipeVersion(versionRow({ allergen_tags: [], diet_tags: [], badges: [] }), []);

            expect(mapped.allergenTags).toEqual([]);
            expect(mapped.dietTags).toEqual([]);
            expect(mapped.badges).toEqual([]);
        });

        it('maps a retired version and a description-less recipe', () => {
            const mapped = mapRecipeVersion(versionRow({ status: 'retired', description: null }), [VALID_INGREDIENT]);

            expect(mapped.status).toBe('retired');
            expect(mapped.description).toBe('');
        });

        it('reads the stored per-serving nutrition rather than recomputing it', () => {
            const mapped = mapRecipeVersion(VALID_VERSION, [VALID_INGREDIENT]);

            expect(mapped.perServing).toEqual({ calories: 610, protein: 45, carbs: 58, fat: 21 });
        });
    });
});

describe('mapRecipeIngredient', () => {
    describe('the amounts it emits', () => {
        it('passes the whole-recipe quantity, gram weight and display text through unscaled', () => {
            // The contract the swap preview and recipe detail both scale from:
            // these are the recipe as published, for `yield_servings` servings,
            // and nothing here knows the portion.
            const mapped = mapRecipeIngredient(VALID_INGREDIENT);

            expect(mapped.quantity).toBe(VALID_INGREDIENT.quantity);
            expect(mapped.unit).toBe(VALID_INGREDIENT.unit);
            expect(mapped.gramWeight).toBe(VALID_INGREDIENT.gram_weight);
            expect(mapped.displayText).toBe(VALID_INGREDIENT.display_text);
        });

        it('is unaffected by the recipe yield, which is the consumer divisor', () => {
            const one = mapRecipeIngredient(VALID_INGREDIENT);
            const four = mapRecipeVersion(versionRow({ yield_servings: 4 }), [VALID_INGREDIENT]).ingredients[0];

            expect(four.quantity).toBe(one.quantity);
            expect(four.gramWeight).toBe(one.gramWeight);
            expect(four.displayText).toBe(one.displayText);
        });
    });

    describe('the frozen identity', () => {
        it('reads the snapshot name and provenance, never a live catalog row', () => {
            const mapped = mapRecipeIngredient(VALID_INGREDIENT);

            expect(mapped.name).toBe('Chicken breast');
            expect(mapped.nutritionProvenance).toBe('source_backed');
            expect(mapped.catalogFoodId).toBe(CATALOG_FOOD_ID);
        });
    });
});

describe('mapPlannedRecipeSummary', () => {
    describe('badges', () => {
        ABSENT_OR_NOT_AN_ARRAY.forEach(([label, value]) => {
            it(`fails the planned meal when the column is ${label}`, () => {
                expect(() => mapPlannedRecipeSummary(versionRow({ badges: value }))).toThrow(RecipeMappingError);
            });
        });

        it('drops an unrecognised badge code', () => {
            expect(mapPlannedRecipeSummary(versionRow({ badges: ['quick', 'sparkly'] })).badges).toEqual(['quick']);
        });
    });

    describe('provenance', () => {
        it('refuses a planned recipe whose nutrition is not source-backed', () => {
            expect(() => mapPlannedRecipeSummary(versionRow({ nutrition_provenance: 'ai_estimated' }))).toThrow(
                RecipeMappingError,
            );
        });

        it('emits the source-backed literal for an eligible recipe', () => {
            expect(mapPlannedRecipeSummary(VALID_VERSION).nutritionProvenance).toBe('source_backed');
        });
    });
});
