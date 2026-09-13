// How a stored nutrition snapshot was arrived at. 'source_backed' = a USDA
// record or scanned label supports the values; 'ingredient_derived' = computed
// from a stored composition whose quantities are assumed, so still an estimate;
// 'ai_estimated' = model output; 'user_entered' = client-supplied values the
// server cannot verify.
export type NutritionProvenance = 'source_backed' | 'ingredient_derived' | 'ai_estimated' | 'user_entered';

// Every value `meal_entries.input_method` may hold. 'meal_plan' belongs to the
// set because the column stores it, never because a request may ask for it: the
// server alone writes it, from `insertPlannedMealEntry`, and it is what earns a
// diary row the "From meal plan" origin caption.
export type EntryInputMethod = 'library' | 'search' | 'ai_text' | 'ai_photo' | 'meal_plan';

// The subset a request body may ask for on the legacy entries path. 'meal_plan'
// is excluded because the caption it drives claims the entry came from a plan
// built out of source-backed ingredients, and a legacy body carries none of
// that — no plan link, no recipe version, and macros the server cannot verify.
// A body naming it is not rejected, it is simply not honoured:
// `resolveLegacyInputMethod` (nutrition.logic.ts) resolves it, like every other
// unrecognised value, to 'library'.
export type ClientInputMethod = Exclude<EntryInputMethod, 'meal_plan'>;

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
    //
    // Every OTHER value is one this union names, and that is an invariant of the
    // write path rather than of the column: `meal_entries.nutrition_provenance`
    // is unrestricted TEXT, so `nutrition.logic.ts` is what keeps an unknown
    // string out of it — `resolveCatalogEntrySnapshot` narrows a catalog food's
    // own provenance before an entry is written and refuses the insert
    // otherwise, because a value outside this union would be read back as
    // `null` here and would silently strip the estimate label §0.1.4(i)
    // requires an AI-estimated or ingredient-derived food to carry in the diary.
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
    // Typed as the wire's loose string because this is an unvalidated request
    // value: a `ClientInputMethod` is honoured and anything else — including
    // the server-written 'meal_plan' — resolves to 'library'.
    inputMethod?: string;
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

// A partial edit of a logged entry: absent members are columns the request does
// not mention and the update leaves alone.
//
// `servings` says how much was eaten and never changes what the food IS, so it
// is always compatible with a plan, recipe or catalog link. The other five
// describe the food itself, and an edit that CHANGES any of them detaches the
// entry from whatever was vouching for those numbers (§0.5.1). "Changes" is
// literal and is decided by `nutrition.logic.ts::planMealEntryEdit` on the
// normalized value — a trimmed name, a rounded macro — compared with what the
// column holds, so re-sending a whole entry unaltered, or retrying a request
// whose response was lost, keeps the link, the "From meal plan" caption and the
// source label rather than erasing them.
//
// The members are typed as the values the endpoint means, not as what an
// unvalidated body may contain: this route has never validated its body, so a
// caller that sends a name or macro of another type reaches the column and is
// refused there, exactly as it has always been.
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
