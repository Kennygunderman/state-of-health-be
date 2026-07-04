export interface MacroTotals {
    calories: number;
    protein: number;
    carbs: number;
    fat: number;
}

export interface MealEntryResponse {
    id: string;
    foodId: string | null;
    name: string;
    servingText: string | null;
    servings: number;
    // Per-serving snapshot values; displayed totals = value * servings.
    calories: number;
    protein: number;
    carbs: number;
    fat: number;
    inputMethod: string;
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

export interface UpdateMealEntryPayload {
    servings?: number;
    name?: string;
    calories?: number;
    protein?: number;
    carbs?: number;
    fat?: number;
}

export interface DailySummaryResponse {
    date: string;
    mealCount: number;
    calories: number;
    protein: number;
    carbs: number;
    fat: number;
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
