import { NutritionProvenance } from './nutrition';

// The three arrays below are the only runtime output in src/types, and the
// backend is the sole enforcement point for these closed sets: the mobile codecs
// decode iconKey and badges leniently as io.string (an unknown iconKey falls back
// to a default glyph, an unknown badge is dropped) and the columns are plain TEXT
// with no enum or CHECK constraint. recipe.logic.ts and scripts/recipes-seed.ts
// check membership against these arrays, so a seed carrying an unknown code fails
// loudly instead of shipping the wrong glyph or silently losing a badge.
export const RECIPE_ICON_KEYS = [
    'crosshair',
    'fork_knife',
    'bowl',
    'wrap',
    'dome',
    'salad',
    'bowl_dash',
    'pot',
    'cloche',
] as const;

export type RecipeIconKey = (typeof RECIPE_ICON_KEYS)[number];

export const RECIPE_BADGES = ['high_protein', 'gluten_free', 'dairy_free', 'vegan', 'quick'] as const;

export type RecipeBadge = (typeof RECIPE_BADGES)[number];

export const MEAL_SLOTS = ['breakfast', 'lunch', 'dinner', 'snack'] as const;

export type MealSlot = (typeof MEAL_SLOTS)[number];

// 'source_backed' | 'ingredient_derived' | 'ai_estimated'. A recipe is never
// 'user_entered': its nutrition is calculated from stored ingredient gram weights,
// never supplied by a client. Narrowed from NutritionProvenance rather than
// restated as literals so the three spellings cannot drift from the diary's.
export type RecipeNutritionProvenance = Exclude<NutritionProvenance, 'user_entered'>;

// Structurally identical to MacroTotals in ./nutrition by design, and deliberately
// a separate declaration: coupling the recipe contract to the diary-totals DTO
// would let a later change to one silently reshape the other.
export interface RecipePerServingNutrition {
    calories: number;
    protein: number;
    carbs: number;
    fat: number;
}

export interface RecipeIngredientResponse {
    catalogFoodId: string;
    // name and nutritionProvenance are read from the frozen recipe_ingredients
    // snapshot columns, not from the live catalog_foods row — which is why a
    // historical plan, recipe detail or diary link keeps showing the values the
    // recipe was published with even after a catalog refresh renames or
    // re-derives that food.
    name: string;
    quantity: number;
    unit: string;
    gramWeight: number;
    displayText: string;
    nutritionProvenance: RecipeNutritionProvenance;
    isOptional: boolean;
}

export interface RecipeVersionResponse {
    versionId: string;
    recipeId: string;
    version: number;
    status: 'current' | 'retired';
    name: string;
    // null when the recipe was published without a description — render nothing.
    description: string | null;
    iconKey: RecipeIconKey;
    instructions: string[];
    yieldServings: number;
    servingDescription: string;
    prepMinutes: number;
    cookMinutes: number;
    // prepMinutes + cookMinutes by definition, and the value the user's cooking
    // time limit is applied to — not an independently authoritative field.
    totalMinutes: number;
    // Tightened from string[] on purpose: the same contract writes these four
    // slots as a closed union elsewhere and the seed validates them anyway, so
    // MealSlot[] is wire-identical and stricter. Not a mistake to widen back.
    mealSlots: MealSlot[];
    badges: RecipeBadge[];
    // Left open on purpose, unlike their tightened neighbours above: these are
    // taxonomies drawn from catalog food metadata, so a legitimate new diet or
    // allergen tag must not become a compile error in this repository.
    dietTags: string[];
    allergenTags: string[];
    allergenStatus: 'known' | 'unknown';
    budgetTier: 1 | 2 | 3;
    nutritionProvenance: RecipeNutritionProvenance;
    perServing: RecipePerServingNutrition;
    ingredients: RecipeIngredientResponse[];
}
