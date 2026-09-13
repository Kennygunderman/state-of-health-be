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

// EVERY AMOUNT ON THIS SHAPE IS A WHOLE-RECIPE AMOUNT — the recipe as
// published, which yields RecipeVersionResponse.yieldServings servings. That
// holds for quantity, gramWeight and the pre-formatted displayText alike,
// because all three are stored that way in recipe_ingredients and nothing here
// is scaled: a recipe response carries no planned-meal context, so the portion
// is not known at this layer.
//
// A consumer that shows ONE PORTION therefore scales, using the multiplier that
// arrives beside the recipe in its own response —
// MealPlanMealResponse.portionMultiplier for a planned meal,
// SwapPreviewAlternative.portionMultiplier for the swap preview:
//
//     portion amount = quantity × portionMultiplier / yieldServings
//
// Stated here because it is the one thing about this shape that is not visible
// from the shape: a reader who assumes displayText is already the portion's
// amount ships ingredient quantities that contradict the portion-scaled
// nutrition printed beside them. Both mobile screens apply the formula through
// one shared helper (mobile/src/utility/RecipeIngredientUtility.ts) rather than
// each carrying its own copy of it.
export interface RecipeIngredientResponse {
    catalogFoodId: string;
    // name and nutritionProvenance are read from the frozen recipe_ingredients
    // snapshot columns, not from the live catalog_foods row — which is why a
    // historical plan, recipe detail or diary link keeps showing the values the
    // recipe was published with even after a catalog refresh renames or
    // re-derives that food.
    name: string;
    // The whole recipe's amount of this ingredient, in `unit`.
    quantity: number;
    unit: string;
    // The whole recipe's grams of this ingredient — what the recipe's nutrition
    // was derived from at publication and what the grocery list aggregates.
    gramWeight: number;
    // The whole recipe's amount, pre-formatted ("¾ cup"). Not a portion amount,
    // and not a substitute for the formula above.
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
    // The recipe_versions.description column is nullable; this wire member is not.
    // A recipe published without a description travels as an empty string, so the
    // client renders nothing without branching on null.
    description: string;
    iconKey: RecipeIconKey;
    // Never empty. The steps are what a recipe is cooked from (frame 12 renders
    // them as a numbered list), the column is JSONB NOT NULL, and the seed
    // publishes them with the version — so recipe.mapper.ts fails the response
    // rather than emitting an empty list, which would read as a complete recipe
    // with nothing to do.
    instructions: string[];
    // How many servings the whole recipe makes, and the divisor every
    // per-portion amount on RecipeIngredientResponse is derived with.
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
    //
    // Both are the derived union of every ingredient's frozen tags, optional
    // ingredients included, and planning eligibility is decided against exactly
    // that union — so an EMPTY list is the positive claim "contains none of the
    // named allergens" / "carries no dietary restriction", never "unknown".
    // Whether a recipe's allergen data is unknown is stated separately by
    // allergenStatus. Their columns are NOT NULL and recipe.mapper.ts reads
    // them rather than defaulting them, so a row that cannot supply one fails
    // the response instead of widening what the recipe appears safe for.
    dietTags: string[];
    allergenTags: string[];
    allergenStatus: 'known' | 'unknown';
    budgetTier: 1 | 2 | 3;
    nutritionProvenance: RecipeNutritionProvenance;
    perServing: RecipePerServingNutrition;
    ingredients: RecipeIngredientResponse[];
}
