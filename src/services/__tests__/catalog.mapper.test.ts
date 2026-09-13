/**
 * `catalog.mapper.ts` is the row -> DTO boundary of the internal food catalog,
 * and this suite exists for the one decision on that boundary a reader cannot
 * check by inspection: `defaultPortionNutrition`, the server-computed nutrition
 * of ONE default portion.
 *
 * What it pins, and why each is a decision someone could break:
 *
 *  - **The basis is converted, never assumed.** The stored macros are per
 *    `basis_amount` of `nutrition_basis`; the projection restates them per
 *    default portion. A 195 g cup of cooked rice must not carry the 100 g
 *    figures, and a `per_100ml` food must pass through `density_g_per_ml` —
 *    the conversion the client cannot perform, because that column is on no
 *    response.
 *  - **Rounding happens exactly ONCE, after scaling.** `meal_entries` stores
 *    per-serving macros as `Int` and the read path multiplies that snapshot by
 *    the eaten servings, so the pre-log card equals the diary row only if both
 *    round the same value the same number of times. Protein 2.7 g/100 g at a
 *    195 g portion is 5 g, not the 6 g an intermediate rounding would give.
 *  - **A broken promise is a fault, not a default.** Validation quarantines a
 *    candidate with a missing density, a non-positive basis amount, no default
 *    portion or a null core macro, so a published row that has one is a
 *    data-integrity fault: it raises `CatalogMappingError` naming the column
 *    and the food. Inventing a density or defaulting a macro to 0 would log
 *    numbers nobody measured under a source-backed label.
 *  - **The projection is ADDITIVE.** The basis metadata and the per-basis
 *    macros still travel unchanged beside it, because the recipe and grocery
 *    paths convert through them.
 *
 * The formula under test is the same one `nutrition.service.ts` applies when a
 * catalog food is logged (`basisGrams` / `catalogPortionSnapshot`, being
 * extracted to `nutrition.logic.ts` under review finding F05). The numbers
 * asserted here are therefore also the numbers that end up stored, which is the
 * whole point of the projection.
 *
 * Pure and synchronous: no database, no Prisma client, no clock.
 */

import { CatalogPortionNutritionResponse } from '../../types/catalog';
import {
    CatalogFoodPortionRow,
    CatalogFoodRow,
    CatalogMappingError,
    deriveDefaultPortionNutrition,
    mapCatalogFood,
} from '../catalog.mapper';

/* ---------------------------------------------------------------------------
 * Fixtures — rows exactly as stored, snake_case
 * ------------------------------------------------------------------------- */

const portionRow = (overrides: Partial<CatalogFoodPortionRow> = {}): CatalogFoodPortionRow => ({
    description: '1 cup',
    amount: 1,
    unit: 'cup',
    gram_weight: 195,
    is_default: true,
    ...overrides,
});

/** Brown rice, cooked — the per-100 g case, stated per 100 g. */
const foodRow = (overrides: Partial<CatalogFoodRow> = {}): CatalogFoodRow => ({
    id: 'catalog-food-rice',
    display_name: 'Brown rice, cooked',
    category: 'grain_rice',
    food_state: 'cooked',
    identity_source: 'usda',
    nutrition_provenance: 'source_backed',
    nutrition_basis: 'per_100g',
    basis_amount: 100,
    calories: 123,
    protein_g: 2.7,
    carbs_g: 26,
    fat_g: 1,
    fiber_g: 1.6,
    density_g_per_ml: null,
    allergen_tags: [],
    allergen_status: 'known',
    food_group: 'rice',
    ...overrides,
});

/** Olive oil — the per-100 ml case, which only density can turn into grams. */
const oliveOilRow = (overrides: Partial<CatalogFoodRow> = {}): CatalogFoodRow =>
    foodRow({
        id: 'catalog-food-olive-oil',
        display_name: 'Olive oil',
        category: 'fat_oil',
        food_state: 'as_purchased',
        nutrition_basis: 'per_100ml',
        basis_amount: 100,
        calories: 884,
        protein_g: 0,
        carbs_g: 0,
        fat_g: 100,
        fiber_g: 0,
        density_g_per_ml: 0.918,
        food_group: 'oil',
        ...overrides,
    });

const oliveOilPortion = portionRow({ description: '1 tbsp', amount: 1, unit: 'tbsp', gram_weight: 13.5 });

const projectionOf = (food: CatalogFoodRow, portion: CatalogFoodPortionRow): CatalogPortionNutritionResponse =>
    mapCatalogFood(food, [portion]).defaultPortionNutrition;

/* ---------------------------------------------------------------------------
 * per_100g
 * ------------------------------------------------------------------------- */

describe('deriveDefaultPortionNutrition — per_100g', () => {
    it('restates the 100 g figures as the 195 g cup they are served in', () => {
        // 123 x 1.95 = 239.85, 2.7 x 1.95 = 5.265, 26 x 1.95 = 50.7, 1 x 1.95 = 1.95
        expect(projectionOf(foodRow(), portionRow())).toEqual({
            calories: 240,
            protein: 5,
            carbs: 51,
            fat: 2,
        });
    });

    it('rounds each value once, after scaling', () => {
        // Rounding the nutrient first would give round(3 x 1.95) = 6 g of protein.
        expect(projectionOf(foodRow(), portionRow()).protein).toBe(5);
    });

    it('scales a portion smaller than the basis down, so a 30 g portion is not the 100 g figure', () => {
        const thirtyGrams = portionRow({ description: '30 g', amount: 30, unit: 'g', gram_weight: 30 });

        expect(projectionOf(foodRow(), thirtyGrams)).toEqual({ calories: 37, protein: 1, carbs: 8, fat: 0 });
    });

    it('passes the figures through unchanged for a portion of exactly the basis mass', () => {
        const hundredGrams = portionRow({ description: '100 g', amount: 100, unit: 'g', gram_weight: 100 });

        expect(projectionOf(foodRow(), hundredGrams)).toEqual({ calories: 123, protein: 3, carbs: 26, fat: 1 });
    });

    it('rounds a value landing exactly on a half away from zero', () => {
        const oneAndAHalf = portionRow({ description: '150 g', amount: 150, unit: 'g', gram_weight: 150 });
        const food = foodRow({ calories: 1, protein_g: 1, carbs_g: 1, fat_g: 1 });

        expect(projectionOf(food, oneAndAHalf)).toEqual({ calories: 2, protein: 2, carbs: 2, fat: 2 });
    });

    it('keeps a genuinely zero macro at zero rather than treating it as unknown', () => {
        const food = foodRow({ carbs_g: 0, fat_g: 0 });
        const projection = projectionOf(food, portionRow());

        expect(projection.carbs).toBe(0);
        expect(projection.fat).toBe(0);
    });

    it('honours a basis amount other than 100', () => {
        // The same food stated per 50 g: every value is half, so the 195 g cup
        // is twice the basis-100 result.
        const perFiftyGrams = foodRow({ basis_amount: 50, calories: 61.5, protein_g: 1.35, carbs_g: 13, fat_g: 0.5 });

        expect(projectionOf(perFiftyGrams, portionRow())).toEqual({
            calories: 240,
            protein: 5,
            carbs: 51,
            fat: 2,
        });
    });
});

/* ---------------------------------------------------------------------------
 * per_100ml
 * ------------------------------------------------------------------------- */

describe('deriveDefaultPortionNutrition — per_100ml', () => {
    it('converts through density before scaling, so a tablespoon of olive oil is 130 kcal', () => {
        // basisGrams = 100 ml x 0.918 g/ml = 91.8 g; scale = 13.5 / 91.8 = 0.147058…
        expect(projectionOf(oliveOilRow(), oliveOilPortion)).toEqual({
            calories: 130,
            protein: 0,
            carbs: 0,
            fat: 15,
        });
    });

    it('would report a different number without the density, which is why the column is read', () => {
        // Treating 100 ml as 100 g gives round(884 x 0.135) = 119 kcal, not 130.
        expect(projectionOf(oliveOilRow(), oliveOilPortion).calories).not.toBe(119);
    });

    it('raises rather than assuming 1 g/ml when the density is null', () => {
        expect(() => projectionOf(oliveOilRow({ density_g_per_ml: null }), oliveOilPortion)).toThrow(
            CatalogMappingError,
        );
    });

    it('names the density column and the food when the density is missing', () => {
        expect(() => projectionOf(oliveOilRow({ density_g_per_ml: null }), oliveOilPortion)).toThrow(
            /catalog_foods\.density_g_per_ml is null for published food catalog-food-olive-oil/,
        );
    });

    it('raises for a zero density, which would make the basis mass zero', () => {
        expect(() => projectionOf(oliveOilRow({ density_g_per_ml: 0 }), oliveOilPortion)).toThrow(CatalogMappingError);
    });

    it('raises for a negative density', () => {
        expect(() => projectionOf(oliveOilRow({ density_g_per_ml: -0.918 }), oliveOilPortion)).toThrow(
            CatalogMappingError,
        );
    });

    it('raises for a non-finite density', () => {
        expect(() => projectionOf(oliveOilRow({ density_g_per_ml: Number.NaN }), oliveOilPortion)).toThrow(
            CatalogMappingError,
        );
    });

    it('ignores the density on a per_100g row, where it is not part of the conversion', () => {
        const withDensity = foodRow({ density_g_per_ml: 0.5 });

        expect(projectionOf(withDensity, portionRow())).toEqual(projectionOf(foodRow(), portionRow()));
    });
});

/* ---------------------------------------------------------------------------
 * per_serving
 * ------------------------------------------------------------------------- */

describe('deriveDefaultPortionNutrition — per_serving', () => {
    const perServingFood = (overrides: Partial<CatalogFoodRow> = {}): CatalogFoodRow =>
        foodRow({
            id: 'catalog-food-bar',
            display_name: 'Protein bar',
            nutrition_basis: 'per_serving',
            basis_amount: 1,
            calories: 210,
            protein_g: 20,
            carbs_g: 21,
            fat_g: 7,
            ...overrides,
        });

    const thirtyGramBar = portionRow({ description: '1 bar', amount: 1, unit: 'bar', gram_weight: 30 });

    it('passes one serving through unchanged when the basis is one default portion', () => {
        expect(projectionOf(perServingFood(), thirtyGramBar)).toEqual({
            calories: 210,
            protein: 20,
            carbs: 21,
            fat: 7,
        });
    });

    it('halves the figures when the basis is two default portions', () => {
        expect(projectionOf(perServingFood({ basis_amount: 2 }), thirtyGramBar)).toEqual({
            calories: 105,
            protein: 10,
            carbs: 11,
            fat: 4,
        });
    });

    it('is independent of the portion gram weight, which appears on both sides of the ratio', () => {
        const heavierBar = portionRow({ description: '1 bar', amount: 1, unit: 'bar', gram_weight: 60 });

        expect(projectionOf(perServingFood(), heavierBar)).toEqual(projectionOf(perServingFood(), thirtyGramBar));
    });
});

/* ---------------------------------------------------------------------------
 * Faults — the guarantees the response type makes
 * ------------------------------------------------------------------------- */

describe('deriveDefaultPortionNutrition — data-integrity faults', () => {
    it('raises for a zero basis amount', () => {
        expect(() => projectionOf(foodRow({ basis_amount: 0 }), portionRow())).toThrow(
            /catalog_foods\.basis_amount is 0 for published food catalog-food-rice/,
        );
    });

    it('raises for a negative basis amount', () => {
        expect(() => projectionOf(foodRow({ basis_amount: -100 }), portionRow())).toThrow(CatalogMappingError);
    });

    it('raises for a non-finite basis amount', () => {
        expect(() => projectionOf(foodRow({ basis_amount: Number.POSITIVE_INFINITY }), portionRow())).toThrow(
            CatalogMappingError,
        );
    });

    it('raises for a null core macro rather than reporting it as 0', () => {
        expect(() => projectionOf(foodRow({ protein_g: null }), portionRow())).toThrow(
            /catalog_foods\.protein_g is null for published food catalog-food-rice/,
        );
    });

    it('raises for a non-finite core macro', () => {
        expect(() => projectionOf(foodRow({ calories: Number.NaN }), portionRow())).toThrow(CatalogMappingError);
    });

    it('raises when the food has no default portion to project onto', () => {
        expect(() => projectionOf(foodRow(), portionRow({ is_default: false }))).toThrow(
            /catalog food catalog-food-rice has no default portion/,
        );
    });

    it('raises for a default portion whose gram weight is zero', () => {
        expect(() => projectionOf(foodRow(), portionRow({ gram_weight: 0 }))).toThrow(CatalogMappingError);
    });

    it('raises when the portion is handed in directly with an unusable gram weight', () => {
        expect(() =>
            deriveDefaultPortionNutrition(foodRow(), { description: '1 cup', amount: 1, unit: 'cup', gramWeight: 0 }),
        ).toThrow(/catalog_food_portions\.gram_weight is 0 for published food catalog-food-rice/);
    });

    it('raises for a nutrition basis outside the closed set', () => {
        expect(() => projectionOf(foodRow({ nutrition_basis: 'per_ounce' }), portionRow())).toThrow(
            /catalog_foods\.nutrition_basis holds unsupported value 'per_ounce'/,
        );
    });

    it('raises when the scale overflows to a non-finite ratio', () => {
        // Both factors are positive and finite, and their ratio still is not:
        // a denormal basis mass under a real portion weight divides to Infinity.
        const denormalBasis = foodRow({ basis_amount: Number.MIN_VALUE });
        const heavyPortion = portionRow({ gram_weight: 1e308 });

        expect(() => projectionOf(denormalBasis, heavyPortion)).toThrow(
            /default-portion scale for published food catalog-food-rice is Infinity/,
        );
    });
});

/* ---------------------------------------------------------------------------
 * The projection beside the rest of the response
 * ------------------------------------------------------------------------- */

describe('mapCatalogFood', () => {
    it('carries the per-basis members through unchanged beside the projection', () => {
        const response = mapCatalogFood(foodRow(), [portionRow()]);

        expect(response.nutritionBasis).toBe('per_100g');
        expect(response.basisAmount).toBe(100);
        expect(response.calories).toBe(123);
        expect(response.protein).toBe(2.7);
        expect(response.carbs).toBe(26);
        expect(response.fat).toBe(1);
        expect(response.fiber).toBe(1.6);
        expect(response.defaultPortionNutrition).toEqual({ calories: 240, protein: 5, carbs: 51, fat: 2 });
    });

    it('reports the same portion the projection was computed from', () => {
        const response = mapCatalogFood(foodRow(), [portionRow(), portionRow({ is_default: false, gram_weight: 98 })]);

        expect(response.defaultPortion).toEqual({ description: '1 cup', amount: 1, unit: 'cup', gramWeight: 195 });
        expect(response.defaultPortionNutrition.calories).toBe(240);
    });

    it('leaves fiber out of the projection, because meal_entries stores no fiber column', () => {
        const response = mapCatalogFood(foodRow(), [portionRow()]);

        expect(Object.keys(response.defaultPortionNutrition).sort()).toEqual([
            'calories',
            'carbs',
            'fat',
            'protein',
        ]);
    });

    it('keeps an unknown fiber value null on the response and still projects the four macros', () => {
        const response = mapCatalogFood(foodRow({ fiber_g: null }), [portionRow()]);

        expect(response.fiber).toBeNull();
        expect(response.defaultPortionNutrition).toEqual({ calories: 240, protein: 5, carbs: 51, fat: 2 });
    });

    it('projects a per_100ml food onto its default portion within the full response', () => {
        const response = mapCatalogFood(oliveOilRow(), [oliveOilPortion]);

        expect(response.nutritionBasis).toBe('per_100ml');
        expect(response.calories).toBe(884);
        expect(response.defaultPortion.gramWeight).toBe(13.5);
        expect(response.defaultPortionNutrition).toEqual({ calories: 130, protein: 0, carbs: 0, fat: 15 });
    });
});
