// The row -> DTO boundary for the internal food catalog: the one place a
// `catalog_foods` row, its portions, and a frozen `recipe_ingredients` snapshot
// become the camelCase wire shapes `src/types/catalog.ts` declares and the
// mobile io-ts codecs decode. One shape, one mapper — a second builder for any
// of these responses is drift, and drift here is a client that stops decoding.
//
// Promoted out of `catalog.service.ts` because two services need it:
// `catalog.service.ts` maps live catalog rows for GET /catalog/foods,
// /catalog/foods/suggestions and /catalog/status, and `recipe.mapper.ts` reads
// an ingredient's frozen identity through `mapIngredientSnapshot`.
//
// Pure and synchronous throughout — no Prisma client, no fetch, no clock, no
// `process.env`. Rows arrive as arguments because the service owns every query.
// That is also why the row types below are structural rather than Prisma's
// generated models: catalog search reads through `$queryRaw`, whose rows carry
// no model type at all, and a mapper that insisted on a model type would push
// its callers into casts.
//
// Four conventions this file holds the line on:
//
//  * CODES GO ON THE WIRE, NEVER PROSE. `nutritionProvenance`,
//    `allergenStatus`, `category`, `foodState`, `identitySource` and
//    `foodGroup` travel as the codes the database stores; the mobile app
//    renders them through `src/constants/strings.ts`, where the three
//    provenance pills ("Source-backed" / "Estimated from ingredients" /
//    "AI estimate") live. Labelling here would hard-code English into the API
//    and duplicate a mapping the client already owns.
//
//  * NAMES ARE DATA. `display_name` and `snapshot_name` pass through untouched
//    — no title-casing, no trimming. `titleCase` in `usda.service.ts` exists to
//    repair raw BRANDED USDA descriptions; catalog names are curated before
//    publication and re-casing them would corrupt deliberate spellings.
//
//  * NULL MEANS UNKNOWN, and is never coerced to 0. `catalog.logic.ts` keeps
//    that distinction all the way through validation; undoing it at the
//    boundary would publish a nutrition claim the source never made.
//
//  * A BROKEN PROMISE IS A FAULT, NOT A DEFAULT. The response type promises a
//    non-null `defaultPortion` and four non-null macros because validation
//    quarantines any candidate missing them, and it promises the allergen and
//    diet lists because their columns are NOT NULL. A published row that
//    contradicts any of that is a data-integrity fault and this file throws —
//    see `CatalogMappingError`.

import {
    CatalogAllergenStatus,
    CatalogFoodPortionResponse,
    CatalogFoodResponse,
    CatalogFoodState,
    CatalogIdentitySource,
    CatalogNutritionBasis,
    CatalogNutritionProvenance,
    CatalogStatusResponse,
    CatalogSuggestionResponse,
} from '../types/catalog';
import {
    CatalogNutrientValues,
    isCatalogAllergenStatus,
    isCatalogFoodState,
    isCatalogIdentitySource,
    isCatalogNutritionBasis,
    isCatalogNutritionProvenance,
    normalizeToPer100g,
} from './catalog.logic';

/* ---------------------------------------------------------------------------
 * The one failure this boundary can have
 * ------------------------------------------------------------------------- */

/**
 * A stored row contradicted a guarantee `src/types/catalog.ts` makes to the
 * client: a published food with no default portion, a core macro that is null
 * or non-finite, a code column holding a value outside its closed set, a
 * required allergen or diet list that is absent or is not an array of strings,
 * or an ingredient snapshot that is not an object.
 *
 * Loud on purpose, because every one of these is prevented upstream — the
 * validation pipeline quarantines such candidates and `catalog.logic.ts` owns
 * the closed sets — so reaching this error means a row was written around the
 * pipeline. Both quiet alternatives are worse than a 500:
 *
 *  * emitting `null` breaks a field the mobile decoder declares non-nullable,
 *    failing the whole response rather than the one bad row, and
 *  * defaulting a macro to 0 states that the food contains none of that
 *    nutrient — a fabricated value, which is the precise thing the catalog's
 *    nutrition-integrity policy exists to prevent.
 *
 * `reps ?? 0` is a safe default; `calories ?? 0` is a false claim. That is the
 * whole distinction this class encodes.
 */
export class CatalogMappingError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'CatalogMappingError';
    }
}

/* ---------------------------------------------------------------------------
 * Row inputs — snake_case, exactly as stored
 * ------------------------------------------------------------------------- */

/** One `catalog_food_portions` row: a portion and its gram conversion. */
export interface CatalogFoodPortionRow {
    description: string;
    amount: number;
    unit: string;
    gram_weight: number;
    is_default: boolean;
}

/**
 * A `catalog_foods` row, narrowed to the columns the wire shape needs.
 *
 * The code columns are typed `string` because that is what the database holds:
 * plain TEXT with no Prisma enum and no CHECK constraint, deliberately, so that
 * `catalog.logic.ts` is the single enforcement point for the closed sets. They
 * are narrowed on the way out, here, so no caller carries a cast.
 *
 * The four macros are nullable here and non-null on the response for the same
 * reason: the column permits unknown, a published row does not.
 */
export interface CatalogFoodRow {
    id: string;
    display_name: string;
    category: string;
    food_state: string;
    identity_source: string;
    nutrition_provenance: string;
    nutrition_basis: string;
    basis_amount: number;
    calories: number | null;
    protein_g: number | null;
    carbs_g: number | null;
    fat_g: number | null;
    fiber_g: number | null;
    // Read because restating the basis as a mass needs it: a `per_100ml` food
    // states its nutrients against a volume, and density is the only thing that
    // turns that volume into the grams a portion is measured in. Nullable
    // because the column is, and null is a fault on a `per_100ml` row rather
    // than a value to substitute — see {@link resolveMassBasis}.
    density_g_per_ml: number | null;
    // Non-null, because the column is `TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[]`
    // and the response declares `allergenTags: string[]`. It is still read
    // through `requireTagArray` on the way out: this type is the claim
    // `$queryRaw<CatalogFoodRow[]>` makes about its own statement, not a proof
    // of it, and the value is a SAFETY claim, so an absent one fails the
    // response instead of becoming "contains no allergens".
    allergen_tags: string[];
    allergen_status: string;
    food_group: string;
}

/**
 * The three columns the dislike-suggestion chips need. Structurally a subset of
 * {@link CatalogFoodRow}, so a full row satisfies it without a second query.
 */
export interface CatalogSuggestionRow {
    id: string;
    display_name: string;
    food_group: string;
}

/**
 * The active release pointer, already resolved by the service: the newest
 * `catalog_import_runs` row with `kind = 'release_load'` and
 * `status = 'succeeded'`. That rule is a query and stays in the service — this
 * file maps whichever row it is handed, or `null` before any release is loaded.
 */
export interface CatalogReleaseRunRow {
    manifest_version: string;
    finished_at: Date | null;
}

/** The counts `GET /catalog/status` reports, each one a separate aggregate. */
export interface CatalogStatusCounts {
    publishedCount: number;
    quarantinedCount: number;
    rejectedCount: number;
    recipeCount: number;
}

/**
 * The frozen columns of one `recipe_ingredients` row — identity, display,
 * provenance and safety metadata as they stood when the recipe version was
 * published, plus the catalog versions they were copied from.
 *
 * `snapshot_per_100g` is `unknown` because the column is JSONB: the generated
 * client types it as a JSON value, and a `$queryRaw` projection as whatever it
 * finds. It is read defensively rather than asserted.
 *
 * The two tag columns are NOT NULL (`TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[]`)
 * and are the frozen SAFETY metadata the whole snapshot exists to preserve, so
 * they are typed non-null and read through `requireTagArray`: an absent one is
 * drift, and defaulting it would restate a published recipe's allergen and diet
 * facts as "none" after the fact.
 */
export interface RecipeIngredientSnapshotRow {
    catalog_food_id: string;
    catalog_nutrition_version: number;
    catalog_metadata_version: number;
    snapshot_per_100g: unknown;
    snapshot_name: string;
    snapshot_provenance: string;
    snapshot_allergen_tags: string[];
    snapshot_diet_tags: string[];
}

/**
 * What a published recipe version froze about one of its ingredients.
 *
 * Deliberately not `RecipeIngredientResponse`: this is the catalog half of that
 * DTO — the identity, provenance and safety facts — which `recipe.mapper.ts`
 * combines with the recipe's own quantity, unit, gram weight, display text and
 * optional flag. Keeping the two apart is what stops a recipe response from
 * needing the live `catalog_foods` row at all.
 *
 * `nutritionProvenance` is `CatalogNutritionProvenance`, which is the same
 * three codes as `RecipeNutritionProvenance` (both exclude `'user_entered'`,
 * since neither a catalog food nor a recipe carries client-supplied values), so
 * it assigns straight into the recipe DTO.
 */
export interface CatalogIngredientSnapshot {
    catalogFoodId: string;
    name: string;
    nutritionProvenance: CatalogNutritionProvenance;
    allergenTags: string[];
    dietTags: string[];
    /** Per 100 g as frozen, each nutrient `null` where it was unknown. */
    per100g: CatalogNutrientValues;
    nutritionVersion: number;
    metadataVersion: number;
}

/* ---------------------------------------------------------------------------
 * Reading a stored column into the type the contract promises
 * ------------------------------------------------------------------------- */

/**
 * Narrows a TEXT code column to its closed set using the guard
 * `catalog.logic.ts` exports for it, throwing on anything else.
 *
 * The guard does the deciding; this only applies it at the boundary and names
 * the column in the failure, so an operator reading the log knows which column
 * of which row to repair.
 */
const narrowColumn = <T extends string>(
    value: string,
    isMember: (candidate: unknown) => candidate is T,
    table: string,
    column: string,
    rowId: string,
): T => {
    if (!isMember(value)) {
        throw new CatalogMappingError(
            `${table}.${column} holds unsupported value '${value}' for row ${rowId}`,
        );
    }

    return value;
};

/**
 * A nutrient the response declares non-null.
 *
 * Non-finite is rejected alongside null because `JSON.stringify(NaN)` is
 * `"null"` — a NaN would reach the client as exactly the null this field
 * promises never to be, and break decoding just as a stored null would.
 */
const requireCoreNutrient = (value: number | null, column: string, foodId: string): number => {
    if (value === null || !Number.isFinite(value)) {
        throw new CatalogMappingError(
            `catalog_foods.${column} is ${value === null ? 'null' : String(value)} for published food ` +
                `${foodId}; a candidate missing a core macro is quarantined, never published`,
        );
    }

    return value;
};

/**
 * A nutrient that may legitimately be unknown: absent or unusable stays null.
 *
 * Takes `unknown` so it serves both a typed column and a member read out of the
 * JSONB snapshot without either caller needing a cast.
 */
const optionalNutrient = (value: unknown): number | null =>
    typeof value === 'number' && Number.isFinite(value) ? value : null;

/**
 * A required allergen or diet list as the array the contract promises, throwing
 * on anything else.
 *
 * These are the columns a safety decision is made from — planning eligibility
 * compares the user's allergens and diet against the union of every
 * ingredient's tags (§0.7.3), and the client shows what a food contains — so
 * `[]` is not "unknown" on this contract. It is the positive claim "contains
 * none of the named allergens" / "carries no dietary restriction". Every one of
 * these columns is NOT NULL, so an absent value is drift or a projection that
 * dropped the column, and `?? []` would answer it by making that claim on
 * behalf of a row that never made it. Whether a food's allergen data IS unknown
 * is stated separately and explicitly, by `allergen_status`.
 *
 * `reps ?? 0` is a safe default; `allergenTags ?? []` is a false safety claim —
 * the same distinction {@link CatalogMappingError} draws for a null macro, on
 * the field where getting it wrong hurts a user rather than a number. A
 * non-string member throws for the adjacent reason: the wire type is
 * `string[]`, the tag vocabularies are deliberately open so nothing filters
 * them, and a number inside the list would reach the client as a tag.
 */
const requireTagArray = (value: unknown, table: string, column: string, rowId: string): string[] => {
    if (!Array.isArray(value)) {
        throw new CatalogMappingError(
            `${table}.${column} is ${value === null ? 'null' : typeof value}, not an array, for row ` +
                `${rowId}; the column is NOT NULL, and an empty list here would state that the food ` +
                'carries none of these tags rather than that they are unknown',
        );
    }

    return value.map((member, index) => {
        if (typeof member !== 'string') {
            throw new CatalogMappingError(
                `${table}.${column}[${index}] is ${typeof member}, not a string, for row ${rowId}`,
            );
        }

        return member;
    });
};

/* ---------------------------------------------------------------------------
 * Portions
 * ------------------------------------------------------------------------- */

export const mapCatalogPortion = (portion: CatalogFoodPortionRow): CatalogFoodPortionResponse => ({
    description: portion.description,
    amount: portion.amount,
    unit: portion.unit,
    gramWeight: portion.gram_weight,
});

/**
 * The portion every quantity in the app converts through.
 *
 * A partial unique index allows at most one default per food, so the first
 * match is the only match. Absent, or present with an unusable gram weight, is
 * a fault rather than a client condition: validation quarantines a candidate
 * with no portion of known gram weight, and the alternative to throwing is
 * inventing the weight that every recipe gram total and grocery quantity would
 * then be computed from.
 */
const resolveDefaultPortion = (
    foodId: string,
    portions: readonly CatalogFoodPortionRow[],
): CatalogFoodPortionResponse => {
    const defaultPortion = portions.find((portion) => portion.is_default);

    if (!defaultPortion) {
        throw new CatalogMappingError(
            `catalog food ${foodId} has no default portion; a candidate without one is quarantined, ` +
                'never published',
        );
    }

    if (!Number.isFinite(defaultPortion.gram_weight) || defaultPortion.gram_weight <= 0) {
        throw new CatalogMappingError(
            `catalog food ${foodId} has a default portion with gram weight ` +
                `${String(defaultPortion.gram_weight)}; portion weights are positive by constraint`,
        );
    }

    return mapCatalogPortion(defaultPortion);
};

/* ---------------------------------------------------------------------------
 * Restating the BASIS as the mass it describes — never the values
 * ------------------------------------------------------------------------- */

/**
 * The mass basis of one row: the code the response declares, and the grams the
 * row's STORED nutrient values describe.
 *
 * `basisGrams` is `basis_amount` itself for a gram basis, `basis_amount ×
 * density_g_per_ml` for a volume one, and `basis_amount × the default portion's
 * gram weight` for a serving one — so `{nutritionBasis: 'per_100g',
 * basisGrams: 91.8}` beside a stored 275.4 kcal reads as "275.4 kcal per
 * 91.8 g", which is exactly what the source record states. `basis_amount` is
 * already documented as "how much of the food the stated values describe, in
 * the basis's own unit", and `normalizeToPer100g` accepts (and
 * `catalog.logic.test.ts` pins) a `per_100g` row whose `basis_amount` is 50, so
 * a mass basis other than 100 is this codebase's own vocabulary rather than a
 * new convention.
 */
interface CatalogMassBasis {
    /**
     * Always the mass basis code, and read off the conversion rather than
     * written here, so exactly one place decides what basis the wire declares.
     */
    nutritionBasis: CatalogNutritionBasis;
    /** What the row's stated basis weighs, in grams. */
    basisGrams: number;
}

/**
 * The mass the food's stored nutrition describes, or the data-integrity fault
 * that stops it.
 *
 * THE VALUES ARE NOT SCALED — only the basis is restated — and that is the
 * whole point of this shape, so it must not be "simplified" back into a
 * per-100 g rescale. A client reads one portion as
 * `round(storedValue × (gramWeight / basisAmount))`, and the diary snapshot
 * `nutrition.logic.ts::resolveCatalogEntrySnapshot` stores
 * `round(storedValue × (portionGrams / basisGrams))` from the same row, with
 * `basisGrams` from this same `normalizeToPer100g` call on the same inputs and
 * the same default portion weight. Emitting `storedValue × 100 / basisGrams`
 * with `basisAmount: 100` instead would make the client convert an already
 * converted number: algebraically equal, but a ULP apart, which lands on the
 * wrong side of a half-rounding boundary — 275.4 kcal per 100 ml at 0.918 g/ml
 * travelled as 299.99999999999994 and gave a 13.5 g tablespoon 40 kcal on the
 * card against the diary row's 41. Passing the stored values through means both
 * sides evaluate ONE multiplication and ONE `Math.round` over identical
 * doubles, so they are bit-identical by construction for every basis and every
 * row, which is what AAP §0.7.3 requires of the Add Food card and the diary row
 * it produces. It also means the response carries the catalog's own numbers,
 * with only the basis restated.
 *
 * The basis rule is NOT written here. `catalog.logic.ts`'s
 * `normalizeToPer100g` already owns it — grams as stated, millilitres through
 * the food's own `density_g_per_ml`, servings times the default portion's gram
 * weight, plus the overflow cases that arithmetic can reach — and it is tested
 * there. This boundary only supplies the portion weight that rule needs and
 * translates the verdict it returns into {@link CatalogMappingError}, which is
 * the same delegation `nutrition.logic.ts` performs for the diary snapshot, so
 * the two can never disagree about what a basis means. Its integrity checks are
 * needed here in full, not just its arithmetic: a missing, zero, negative or
 * non-finite density, an absent serving gram weight, a non-positive basis
 * amount, and a basis mass or factor that overflows all reach this mapper as a
 * refusal rather than as a number on the wire.
 *
 * A failed check is a fault rather than a value to substitute: the alternatives
 * are assuming a density or a serving weight, which is exactly the fabricated
 * number the catalog's nutrition-integrity policy exists to prevent.
 */
const resolveMassBasis = (
    food: CatalogFoodRow,
    defaultPortion: CatalogFoodPortionResponse,
): CatalogMassBasis => {
    const conversion = normalizeToPer100g({
        nutrition_basis: narrowColumn<CatalogNutritionBasis>(
            food.nutrition_basis,
            isCatalogNutritionBasis,
            'catalog_foods',
            'nutrition_basis',
            food.id,
        ),
        basis_amount: food.basis_amount,
        calories: food.calories,
        protein_g: food.protein_g,
        carbs_g: food.carbs_g,
        fat_g: food.fat_g,
        fiber_g: food.fiber_g,
        density_g_per_ml: food.density_g_per_ml,
        serving_gram_weight: defaultPortion.gramWeight,
    });

    if (conversion.kind === 'error') {
        const { name, observed, bound } = conversion.check;

        throw new CatalogMappingError(
            `published food ${food.id} fails ${name}: observed ${JSON.stringify(observed)}, expected ` +
                `${JSON.stringify(bound)}; the response states its nutrition on the mass basis and never ` +
                'substitutes a density or a portion weight',
        );
    }

    return {
        nutritionBasis: conversion.normalized.nutrition_basis,
        basisGrams: conversion.normalized.basisGrams,
    };
};

/* ---------------------------------------------------------------------------
 * The catalog food itself
 * ------------------------------------------------------------------------- */

/**
 * A published `catalog_foods` row and its portions as the search and detail
 * responses carry it.
 *
 * `portions` is the food's own portion set — the caller includes it with the
 * row; only the default is reported, because the response exposes one portion
 * and the rest inform conversions the server performs.
 *
 * The four macros and `fiber` are the row's STORED values, read through the
 * guards below and never scaled here. What is restated is the BASIS they are
 * stated against: {@link resolveMassBasis} converts it into the grams those
 * stored values describe, so `basisAmount` is a mass and `nutritionBasis` the
 * mass-basis code. That is what makes the response projectable without
 * fabricating anything: `density_g_per_ml` is a column no response carries, so
 * a volume basis on the wire would leave the client holding millilitres it
 * cannot convert, while a mass basis and `defaultPortion.gramWeight` are all a
 * client needs to scale by `gramWeight / basisAmount`. The conversion happens
 * where the density column is available: here. Scaling the values as well would
 * convert them twice and break the integer equality with the diary row —
 * {@link resolveMassBasis} has that argument in full.
 *
 * The default portion is resolved once and used twice — as the reported portion
 * and as the serving weight a `per_serving` basis is read against — so the
 * response cannot report one portion while its basis mass was derived from
 * another.
 */
export const mapCatalogFood = (
    food: CatalogFoodRow,
    portions: readonly CatalogFoodPortionRow[],
): CatalogFoodResponse => {
    const defaultPortion = resolveDefaultPortion(food.id, portions);
    const massBasis = resolveMassBasis(food, defaultPortion);

    return {
        id: food.id,
        name: food.display_name,
        category: food.category,
        foodState: narrowColumn<CatalogFoodState>(
            food.food_state,
            isCatalogFoodState,
            'catalog_foods',
            'food_state',
            food.id,
        ),
        identitySource: narrowColumn<CatalogIdentitySource>(
            food.identity_source,
            isCatalogIdentitySource,
            'catalog_foods',
            'identity_source',
            food.id,
        ),
        nutritionProvenance: narrowColumn<CatalogNutritionProvenance>(
            food.nutrition_provenance,
            isCatalogNutritionProvenance,
            'catalog_foods',
            'nutrition_provenance',
            food.id,
        ),
        nutritionBasis: massBasis.nutritionBasis,
        // A mass, in grams: what the stored values below describe. 100 for the
        // published rows stated per 100 g, 91.8 for 100 ml of a 0.918 g/ml oil,
        // and the serving's weight for a per-serving label.
        basisAmount: massBasis.basisGrams,
        calories: requireCoreNutrient(food.calories, 'calories', food.id),
        protein: requireCoreNutrient(food.protein_g, 'protein_g', food.id),
        carbs: requireCoreNutrient(food.carbs_g, 'carbs_g', food.id),
        fat: requireCoreNutrient(food.fat_g, 'fat_g', food.id),
        // null here means UNKNOWN, not zero, and is passed through as null: the
        // sources behind the catalog often state no fibre value at all, and a 0
        // would claim the food contains none. This is the one nutrient on the
        // response that may be unknown — the four above cannot be, on a published
        // row — which is why it alone is nullable in the contract.
        fiber: optionalNutrient(food.fiber_g),
        defaultPortion,
        // Read, never defaulted: an absent list would otherwise reach the client as
        // "contains no allergens" on a food nothing established that about.
        allergenTags: requireTagArray(food.allergen_tags, 'catalog_foods', 'allergen_tags', food.id),
        allergenStatus: narrowColumn<CatalogAllergenStatus>(
            food.allergen_status,
            isCatalogAllergenStatus,
            'catalog_foods',
            'allergen_status',
            food.id,
        ),
        foodGroup: food.food_group,
    };
};

/* ---------------------------------------------------------------------------
 * Suggestions and operator status
 * ------------------------------------------------------------------------- */

/**
 * The dislike-suggestion chip shape, and deliberately only three fields: the
 * chip renders a name and stores the food id and its food group, so that
 * selecting "Mushrooms, white" excludes the whole `mushroom` group. Widening
 * this to a full food would ship a search payload to draw a chip.
 */
export const mapCatalogSuggestion = (food: CatalogSuggestionRow): CatalogSuggestionResponse => ({
    id: food.id,
    name: food.display_name,
    foodGroup: food.food_group,
});

/**
 * Operator and acceptance evidence: which catalog release is loaded, when, and
 * how the published set breaks down.
 *
 * `activeRelease` is `null` before any release has been loaded, which is the
 * only state the two nullable members describe. A succeeded run missing
 * `finished_at` reports `lastLoadedAt: null` rather than throwing — unlike the
 * food response, nothing here is a client contract, and a diagnostic endpoint
 * that fails when the data looks odd is useless at the moment it is needed.
 */
export const mapCatalogStatus = (
    activeRelease: CatalogReleaseRunRow | null,
    counts: CatalogStatusCounts,
): CatalogStatusResponse => ({
    catalogRelease: activeRelease?.manifest_version ?? null,
    publishedCount: counts.publishedCount,
    quarantinedCount: counts.quarantinedCount,
    rejectedCount: counts.rejectedCount,
    recipeCount: counts.recipeCount,
    lastLoadedAt: activeRelease?.finished_at ? activeRelease.finished_at.toISOString() : null,
});

/* ---------------------------------------------------------------------------
 * The frozen ingredient snapshot
 * ------------------------------------------------------------------------- */

/**
 * Reads the frozen `snapshot_per_100g` object.
 *
 * A non-object is a fault — the column is written by the seed from a validated
 * catalog row and nothing else writes it. Individual nutrients are reported as
 * stored, `null` where unknown: whether a null core macro makes the recipe
 * ineligible is a rule, and it belongs to `recipe.logic.ts`. This projection
 * reports; the logic layer decides.
 */
const readSnapshotNutrients = (value: unknown, catalogFoodId: string): CatalogNutrientValues => {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        throw new CatalogMappingError(
            `recipe_ingredients.snapshot_per_100g is not an object for catalog food ${catalogFoodId}`,
        );
    }

    const stored = value as Record<string, unknown>;
    const read = (field: string): number | null => optionalNutrient(stored[field]);

    return {
        calories: read('calories'),
        protein_g: read('protein_g'),
        carbs_g: read('carbs_g'),
        fat_g: read('fat_g'),
        fiber_g: read('fiber_g'),
    };
};

/**
 * One `recipe_ingredients` row's frozen catalog identity.
 *
 * Reads the `snapshot_*` columns and nothing else — never the joined
 * `catalog_foods` row, even when the caller has already loaded it. That is the
 * point of the snapshot and the reason this projection is shared rather than
 * inlined: a catalog refresh renames foods, re-derives nutrition and bumps both
 * version counters, and a historical plan, a recipe detail for a retired
 * version, or a diary entry logged months ago must keep reporting what the
 * recipe was published with. Reading the live row here would silently rewrite
 * the past everywhere those three responses are built.
 *
 * The two version numbers travel with the snapshot so `recipe.logic.ts` can
 * compare them against the current catalog row and decide whether the recipe
 * needs republishing — a comparison, not a rewrite.
 */
export const mapIngredientSnapshot = (
    ingredient: RecipeIngredientSnapshotRow,
): CatalogIngredientSnapshot => ({
    catalogFoodId: ingredient.catalog_food_id,
    name: ingredient.snapshot_name,
    nutritionProvenance: narrowColumn<CatalogNutritionProvenance>(
        ingredient.snapshot_provenance,
        isCatalogNutritionProvenance,
        'recipe_ingredients',
        'snapshot_provenance',
        ingredient.catalog_food_id,
    ),
    // The frozen safety facts, read rather than defaulted: these two lists are
    // what a recipe's allergen and diet claims are derived from, so an absent
    // one fails the recipe instead of quietly widening what it is safe for.
    allergenTags: requireTagArray(
        ingredient.snapshot_allergen_tags,
        'recipe_ingredients',
        'snapshot_allergen_tags',
        ingredient.catalog_food_id,
    ),
    dietTags: requireTagArray(
        ingredient.snapshot_diet_tags,
        'recipe_ingredients',
        'snapshot_diet_tags',
        ingredient.catalog_food_id,
    ),
    per100g: readSnapshotNutrients(ingredient.snapshot_per_100g, ingredient.catalog_food_id),
    nutritionVersion: ingredient.catalog_nutrition_version,
    metadataVersion: ingredient.catalog_metadata_version,
});
