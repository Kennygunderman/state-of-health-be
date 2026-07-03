import { BrandedFoodResponse } from '../types/nutrition';

// USDA FoodData Central (public domain — no retention restrictions, so the
// snapshot-at-log-time model is fully legal for this data source).
// Search results carry per-100g/100ml nutrients that we scale to one serving;
// the detail endpoint's labelNutrients are already per-serving.
const DEFAULT_BASE_URL = 'https://api.nal.usda.gov/fdc/v1';

// Nutrient numbers per USDA's data dictionary.
const NUTRIENT_PROTEIN = '203';
const NUTRIENT_FAT = '204';
const NUTRIENT_CARBS = '205';
const NUTRIENT_CALORIES = '208';

export class UsdaError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'UsdaError';
    }
}

const getApiKey = (): string => {
    const apiKey = process.env.USDA_API_KEY;
    if (!apiKey) {
        throw new UsdaError('USDA_API_KEY is not configured');
    }
    return apiKey;
};

const usdaGet = async (path: string, params: Record<string, string>): Promise<any> => {
    const baseUrl = process.env.USDA_BASE_URL || DEFAULT_BASE_URL;
    const query = new URLSearchParams({ ...params, api_key: getApiKey() });
    const response = await fetch(`${baseUrl}${path}?${query.toString()}`);
    if (response.status === 429) {
        throw new UsdaError('USDA rate limit exceeded');
    }
    if (!response.ok) {
        throw new UsdaError(`USDA returned ${response.status}`);
    }
    return response.json();
};

const titleCase = (value: string): string =>
    value
        .toLowerCase()
        .split(' ')
        .map((word) => (word ? word[0].toUpperCase() + word.slice(1) : word))
        .join(' ');

const round = (value: number): number => Math.round(value);

export const searchBrandedFoods = async (query: string): Promise<BrandedFoodResponse[]> => {
    const data = await usdaGet('/foods/search', {
        query,
        dataType: 'Branded',
        pageSize: '20',
        pageNumber: '1',
    });
    const foods = Array.isArray(data?.foods) ? data.foods : [];

    return foods
        .map((food: any): BrandedFoodResponse | null => {
            const servingSize = Number(food?.servingSize);
            if (
                !food?.fdcId ||
                typeof food?.description !== 'string' ||
                !Number.isFinite(servingSize) ||
                servingSize <= 0 ||
                typeof food?.servingSizeUnit !== 'string' ||
                !Array.isArray(food?.foodNutrients)
            ) {
                return null;
            }

            // Search-result nutrients are per 100g/100ml; scale to one serving.
            const perServing = (nutrientNumber: string): number | null => {
                const nutrient = food.foodNutrients.find((n: any) => String(n?.nutrientNumber) === nutrientNumber);
                const value = Number(nutrient?.value);
                return Number.isFinite(value) ? (value * servingSize) / 100 : null;
            };

            const protein = perServing(NUTRIENT_PROTEIN);
            const fat = perServing(NUTRIENT_FAT);
            const carbs = perServing(NUTRIENT_CARBS);
            if (protein === null || fat === null || carbs === null) return null;
            // Prefer USDA's energy value; fall back to 4/4/9 when it's absent.
            const calories = perServing(NUTRIENT_CALORIES) ?? protein * 4 + carbs * 4 + fat * 9;

            const servingText =
                typeof food.householdServingFullText === 'string' && food.householdServingFullText.trim()
                    ? food.householdServingFullText.trim().toLowerCase()
                    : `${servingSize} ${food.servingSizeUnit.toLowerCase()}`;

            return {
                id: String(food.fdcId),
                name: titleCase(food.description),
                brand: typeof food.brandName === 'string' && food.brandName.trim()
                    ? titleCase(food.brandName)
                    : typeof food.brandOwner === 'string' && food.brandOwner.trim()
                        ? titleCase(food.brandOwner)
                        : null,
                servingText,
                calories: round(calories),
                protein: round(protein),
                carbs: round(carbs),
                fat: round(fat),
            };
        })
        .filter((food: BrandedFoodResponse | null): food is BrandedFoodResponse => food !== null);
};

export const getBrandedFood = async (foodId: string): Promise<BrandedFoodResponse | null> => {
    const data = await usdaGet(`/food/${encodeURIComponent(foodId)}`, { format: 'full' });
    if (!data?.fdcId || typeof data?.description !== 'string') return null;

    // Detail responses carry labelNutrients that are already per-serving.
    const label = data.labelNutrients;
    const toValue = (entry: any): number | null => {
        const value = Number(entry?.value);
        return Number.isFinite(value) ? value : null;
    };
    const protein = toValue(label?.protein);
    const carbs = toValue(label?.carbohydrates);
    const fat = toValue(label?.fat);
    if (protein === null || carbs === null || fat === null) return null;
    const calories = toValue(label?.calories) ?? protein * 4 + carbs * 4 + fat * 9;

    const servingSize = Number(data.servingSize);
    const servingText =
        typeof data.householdServingFullText === 'string' && data.householdServingFullText.trim()
            ? data.householdServingFullText.trim().toLowerCase()
            : Number.isFinite(servingSize) && typeof data.servingSizeUnit === 'string'
                ? `${servingSize} ${data.servingSizeUnit.toLowerCase()}`
                : null;

    return {
        id: String(data.fdcId),
        name: titleCase(data.description),
        brand: typeof data.brandName === 'string' && data.brandName.trim()
            ? titleCase(data.brandName)
            : typeof data.brandOwner === 'string' && data.brandOwner.trim()
                ? titleCase(data.brandOwner)
                : null,
        servingText,
        calories: round(calories),
        protein: round(protein),
        carbs: round(carbs),
        fat: round(fat),
    };
};
