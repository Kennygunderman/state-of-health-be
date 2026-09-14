import { NutritionProvenance } from './nutrition';

// The offset-pagination envelope, shared with GET /api/foods so both list
// endpoints page identically. Declared here once, as the wire shape it is;
// `src/utils/pagination.ts` imports it to build the block.
export interface PaginationBlock {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
}

// Identity, nutrition provenance and publication are three INDEPENDENT facts
// about a catalog food, never one mixed enum: a USDA-sourced row can still be
// quarantined, and an AI-estimated row can be published for search while never
// qualifying as recipe-eligible.
export type CatalogIdentitySource = 'usda' | 'ai_generated';

export type CatalogIdentityStatus = 'verified' | 'ambiguous' | 'unsourced';

export type CatalogFoodState = 'raw' | 'cooked' | 'prepared' | 'dry' | 'as_purchased';

// 'retired' is a previously published food that a newer release no longer
// contains: still referenceable by recipes and diary entries, but excluded from
// search, suggestions and new recipe eligibility.
export type CatalogPublicationStatus = 'candidate' | 'published' | 'quarantined' | 'rejected' | 'retired';

export type CatalogNutritionBasis = 'per_100g' | 'per_100ml' | 'per_serving';

export type CatalogAllergenStatus = 'known' | 'unknown';

export type CatalogValidationOutcome = 'accepted' | 'quarantined' | 'rejected';

// What a failed deterministic check costs the candidate: 'reject' =
// physically impossible, 'quarantine' = unusable until more data arrives,
// 'review' = plausible but atypical.
export type CatalogCheckTier = 'reject' | 'quarantine' | 'review';

// Derived rather than restated so the literal spellings can never drift from
// nutrition.ts: 'source_backed' | 'ingredient_derived' | 'ai_estimated'. A
// catalog food is never 'user_entered' — the server owns every catalog value,
// so there is no client-supplied snapshot to classify.
export type CatalogNutritionProvenance = Exclude<NutritionProvenance, 'user_entered'>;

// The portion -> gram conversion a recipe or grocery quantity leaves the
// per-100g basis through.
export interface CatalogFoodPortionResponse {
    description: string;
    amount: number;
    unit: string;
    gramWeight: number;
}

export interface CatalogFoodResponse {
    id: string;
    name: string;
    // category and foodGroup are loose strings on purpose: category is the
    // 21-value coverage-plan list and foodGroup a ~120-value taxonomy, both
    // defined as DATA in data/meal-planning/coverage-plan.v1.json. Narrowing
    // them here would make adding a food group a code change.
    category: string;
    foodState: CatalogFoodState;
    identitySource: CatalogIdentitySource;
    nutritionProvenance: CatalogNutritionProvenance;
    // The four macros and fiber below are the food's STORED values, stated per
    // basisAmount GRAMS — never per defaultPortion. nutritionBasis is therefore
    // always the mass basis, and basisAmount a mass: 100 for a row stored per
    // 100 g, 91.8 for 100 ml of a 0.918 g/ml oil, the serving's weight for a
    // per-serving label.
    //
    // The basis is converted here, and only the basis, because the response
    // carries no density: a volume basis would leave a client holding
    // millilitres it cannot turn into the grams a portion is measured in.
    // `catalog.mapper.ts` therefore restates the basis as its mass and passes
    // the values through unscaled, so that a client reaching one portion with
    // `gramWeight / basisAmount` performs the SAME single multiplication and
    // single rounding over the same stored numbers as the diary snapshot
    // (`nutrition.logic.ts::resolveCatalogEntrySnapshot`) — which is how the
    // pre-log card equals the diary row it produces, to the integer (§0.7.3).
    nutritionBasis: CatalogNutritionBasis;
    basisAmount: number;
    // The four macros are non-null because a candidate missing any of them is
    // quarantined and never published, so a search row can promise them. fiber
    // is nullable because null means UNKNOWN — never 0, which would silently
    // under-report it.
    calories: number;
    protein: number;
    carbs: number;
    fat: number;
    fiber: number | null;
    // Non-null for every published item: validation quarantines a candidate
    // with no portion of known gram weight, so an unpublishable record never
    // reaches this response. The guarantee lives in the validation pipeline,
    // not in this type.
    defaultPortion: CatalogFoodPortionResponse;
    allergenTags: string[];
    allergenStatus: CatalogAllergenStatus;
    foodGroup: string;
}

// One row per food however many of its aliases matched, so items is a set of
// distinct foods.
export interface CatalogSearchResponse {
    items: CatalogFoodResponse[];
    pagination: PaginationBlock;
}

// A deliberately narrow projection for the dislike-suggestion chips — not a
// trimmed CatalogFoodResponse, and not to be conflated with one.
export interface CatalogSuggestionResponse {
    id: string;
    name: string;
    foodGroup: string;
}

export interface CatalogSuggestionsResponse {
    items: CatalogSuggestionResponse[];
}

// Operator and acceptance evidence only — this endpoint has no mobile consumer,
// so no client contract constrains it.
export interface CatalogStatusResponse {
    // Both null until a release has been loaded: the active release is the
    // newest succeeded release-load run, and before the first one there is none.
    catalogRelease: string | null;
    publishedCount: number;
    quarantinedCount: number;
    rejectedCount: number;
    recipeCount: number;
    // null in that same never-loaded state.
    lastLoadedAt: string | null;
}

// One deterministic check and what it observed.
export interface CatalogValidationCheck {
    name: string;
    pass: boolean;
    // Genuinely heterogeneous, and the one place in this file where a loose
    // member is correct: numeric checks compare kcal and mass, identity checks
    // compare names, and a presence check ('missing_gram_weight') has neither an
    // observed value nor a bound.
    observed: number | string | null;
    bound: number | string | null;
    // Recorded on every check, passing or failing: the tier that governs this
    // candidate's disposition — the one applied on a failure, the one the
    // failure would have carried on a pass — so the record is auditable and
    // replayable without consulting the validator's code.
    tier: CatalogCheckTier;
}

// The audit trail for a generated food's identity: one record per URL actually
// retrieved under the SSRF-safe fetch policy.
export interface CatalogIdentityEvidenceRecord {
    // The URL that served the bytes this record describes — after a same-host
    // redirect the hop's target, not the URL originally proposed. The status,
    // hash and snippet below all came from that response, so this is the
    // location a reviewer re-fetches to check them.
    url: string;
    finalHost: string;
    status: number;
    bodySha256: string;
    // null when the page was fetched but the candidate's name was not found in
    // it — evidence that failed to corroborate, which leaves the candidate
    // quarantined rather than published.
    matchedSnippet: string | null;
    fetchedAt: string;
}

// The machine-readable validation record every published food carries — one per
// food, so the outcome is auditable per item rather than per run.
export interface CatalogValidationRecordResponse {
    catalogFoodId: string;
    canonicalIdentity: Record<string, unknown>;
    aliases: string[];
    category: string;
    foodState: CatalogFoodState;
    identitySource: CatalogIdentitySource;
    identityStatus: CatalogIdentityStatus;
    nutritionProvenance: CatalogNutritionProvenance;
    nutritionMethod: string;
    // null when the values needed no assumption — a fully sourced record.
    nutritionAssumptions: string | null;
    portionUnits: Record<string, unknown>;
    identityEvidence: CatalogIdentityEvidenceRecord[];
    checks: CatalogValidationCheck[];
    // Advisory ONLY: a second model's flags never promote a nutrition value to
    // verified, and never publish a candidate the deterministic checks failed.
    // Left open-ended so an advisory payload change is not a contract change.
    llmReview: Record<string, unknown> | null;
    outcome: CatalogValidationOutcome;
    reviewedAt: string;
    publicationStatus: CatalogPublicationStatus;
    // Source dataset name -> the version this record was validated against.
    sourceVersions: Record<string, string>;
    // Append-only prior outcomes for this food; entries are open-ended.
    history: Record<string, unknown>[];
}
