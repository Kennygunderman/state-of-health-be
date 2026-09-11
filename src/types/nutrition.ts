// How a stored nutrition snapshot was arrived at. 'source_backed' = a USDA
// record or scanned label supports the values; 'ingredient_derived' = computed
// from a stored composition whose quantities are assumed, so still an estimate;
// 'ai_estimated' = model output; 'user_entered' = client-supplied values the
// server cannot verify.
export type NutritionProvenance = 'source_backed' | 'ingredient_derived' | 'ai_estimated' | 'user_entered';

export interface MacroTotals {
    calories: number;
    protein: number;
    carbs: number;
    fat: number;
}

export interface MealEntryResponse {
    id: string;
    foodId: string | null;
    // null unless the entry was logged from a planned meal (meal_plan_meals.id);
    // its presence drives the "From meal plan" caption and the plan card's
    // LOGGED state.
    mealPlanMealId: string | null;
    name: string;
    servingText: string | null;
    servings: number;
    // Per-serving snapshot values; displayed totals = value * servings.
    calories: number;
    protein: number;
    carbs: number;
    fat: number;
    inputMethod: string;
    // null is the historical class alone: rows written before this column existed,
    // which the client reads as unknown. A client-supplied snapshot logged through
    // the legacy entries path carries 'user_entered' instead, because the server
    // cannot verify numbers it did not derive; neither class earns a source label.
    nutritionProvenance: NutritionProvenance | null;
    loggedAt: string;
}

export interface MealResponse {
    id: string;
    name: string;
    sortOrder: number;
    entries: MealEntryResponse[];
    totals: MacroTotals;
}

export interface DailyMacrosResponse {
    date: string;
    meals: MealResponse[];
    totals: MacroTotals;
    targets: MacroTargetsResponse;
}

export interface MacroTargetsResponse {
    calories: number | null;
    protein: number | null;
    carbs: number | null;
    fat: number | null;
}

export interface LogMealEntryPayload {
    foodId?: string;
    name: string;
    servingText?: string;
    servings?: number;
    calories: number;
    protein: number;
    carbs: number;
    fat: number;
    inputMethod?: string; // 'library' | 'search' | 'ai_text' | 'ai_photo'
    rawInput?: string;
}

// The catalog counterpart of LogMealEntryPayload — the client names a published
// catalog food and a portion, and the server derives the nutrition snapshot from
// that catalog_foods row, ignoring any client-supplied macro values.
export interface LogCatalogMealEntryPayload {
    catalogFoodId: string;
    servings: number;
    // Accepted only when it matches one of that food's stored portion
    // descriptions; omitted falls back to the default portion's description.
    servingText?: string;
    // The only accepted and stored method, and what reaches
    // meal_entries.input_method. A divergent or absent body value is not
    // rejected: parseLogEntryBody discards it and stamps 'search'.
    inputMethod: 'search';
}

export interface UpdateMealEntryPayload {
    servings?: number;
    name?: string;
    calories?: number;
    protein?: number;
    carbs?: number;
    fat?: number;
}

export interface DaySummaryMealResponse {
    id: string;
    name: string;
    sortOrder: number;
    calories: number;
    protein: number;
    carbs: number;
    fat: number;
}

export interface DailySummaryResponse {
    date: string;
    mealCount: number;
    calories: number;
    protein: number;
    carbs: number;
    fat: number;
    meals: DaySummaryMealResponse[];
}

export interface FoodResponse {
    id: string;
    name: string;
    servingAmount: number;
    servingUnit: string | null;
    calories: number;
    protein: number;
    carbs: number;
    fat: number;
    brand: string | null;
    source: string;
}

export interface CreateFoodPayload {
    name: string;
    servingAmount?: number;
    servingUnit?: string;
    calories: number;
    protein: number;
    carbs: number;
    fat: number;
    brand?: string;
    source?: string; // 'manual' | 'label_scan' | 'branded'
}

export interface EstimateItem {
    name: string;
    quantityText: string;
    calories: number;
    protein: number;
    carbs: number;
    fat: number;
    // 'db_matched' = values grounded in a USDA generic-food entry scaled by the
    // LLM's portion estimate; 'estimated' = pure LLM output.
    source: 'estimated' | 'db_matched';
    matchedTo: string | null; // USDA food description when db_matched
}

export interface EstimateResponse {
    items: EstimateItem[];
    total: MacroTotals;
    confidence: 'low' | 'medium' | 'high';
    notes: string | null;
}

export interface LabelScanResponse {
    name: string | null;
    servingAmount: number | null;
    servingUnit: string | null;
    calories: number;
    protein: number;
    carbs: number;
    fat: number;
    confidence: 'low' | 'medium' | 'high';
}

export interface BrandedFoodResponse {
    id: string;
    name: string;
    brand: string | null;
    servingText: string | null;
    calories: number;
    protein: number;
    carbs: number;
    fat: number;
}
